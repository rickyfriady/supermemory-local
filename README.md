# Supermemory Local + 9router Integration

Project untuk menjalankan server **Supermemory** ([supermemory.ai](https://supermemory.ai/docs/self-hosting/overview)) secara lokal, dengan model embedding dan LLM dari **9router** (terinstall global), ditulis dalam TypeScript dan dijalankan langsung dengan **Bun** (tanpa build), dilengkapi sistem hooks otomatis untuk:

- **Claude Code** (`claude-code`)
- **Antigravity** (`antigravity`)
- **OpenCode** (`opencode`)

Memori diisolasi dan disimpan secara terpisah **berdasarkan folder / base repository Git** tempat CLI agent dibuka, serta **dibagikan secara real-time lintas sesi dan lintas agent CLI**.

---

## 🌟 Fitur Utama

1. **Server Lokal, Model via 9router (bisa diganti kapan saja):**
   - **Embeddings:** Default-nya model lokal `Xenova/bge-base-en-v1.5` (ONNX bawaan server, 768 dimensi, ±106 MB, tanpa panggilan API). Model ini hanya memahami bahasa Inggris, jadi hook menerjemahkan prompt dan ringkasan sesi yang bukan bahasa Inggris lewat `TRANSLATE_MODEL` (model chat di 9router) sebelum dicari atau disimpan. Dengan begitu memori tetap bisa dicari lintas bahasa. Alternatifnya, model embedding multibahasa lewat 9router (`openai-compatible`, mis. `jina/jina-embeddings-v4` 1024 dimensi) dengan `TRANSLATE_MODEL` dikosongkan. Untuk jalur 9router, `llm-proxy` menambahkan `dimensions` (server hanya mengirimnya untuk `text-embedding-3-*`, sedangkan Jina v4 default 2048 dan Gemini 3072, melebihi batas pgvector 2000) dan melengkapi `usage.prompt_tokens` yang tidak dikirim Jina (tanpa itu server menolak respons sebagai "Invalid JSON response").
   - **Storage per Model Embedding:** Database lokal tersimpan di `./data/stores/<model>-<dim>d/`, satu store per model embedding, dan `./data/current` menunjuk ke store aktif. Server mengunci satu folder data ke model yang pertama mengisinya, jadi `scripts/run.sh` memilih (atau membuat) store milik model di `.env`. Mengganti model cukup ubah `.env` lalu restart, dan kembali ke model lama memulihkan memorinya. Lihat [Mengganti Model](#mengganti-model).
   - **Workflow Engine Direct:** Menggunakan `WORKFLOW_ENGINE=direct` sehingga proses ekstraksi dan relasi memori dieksekusi secara in-process langsung tanpa dependensi ke server worker eksternal.
   - **Model AI (LLM):** Ekstraksi memori memakai `OPENAI_MODEL` (mis. `ag/gemini-3.8-flash-low` atau `cc/claude-haiku-4-5-20251001`) lewat gateway lokal **9router** (`http://127.0.0.1:20128/v1`) dan proxy kecil `src/llm-proxy.ts` (port `20129`). Proxy ini menambahkan `"stream": false` ke request chat, karena supermemory tidak mengisi `stream` sedangkan 9router membalas dalam format streaming (SSE) jika `stream` kosong, yang membuat supermemory gagal mem-parsing JSON.

2. **Per-Project & Cross-Agent Shared Memory:**
   - Otomatis mendeteksi root repository Git (`git rev-parse --show-toplevel`) atau direktori kerja saat ini.
   - Setiap project memiliki `containerTag` unik (`proj_<folder>_<hash>`) yang dipakai bersama oleh **Claude Code**, **Antigravity**, dan **OpenCode**.
   - **Clone dari remote yang sama berbagi memori**, begitu juga worktree-nya. Folder yang hanya berisi banyak repo (misalnya `~/dev/personal`) dan `$HOME` bukan project, jadi memorinya tidak bercampur. Lihat [Identitas Project](#-identitas-project-clone-bersama-dan-folder-kumpulan-repo).
   - Setiap memori yang disimpan dilabeli dengan agent asalnya (misal `[Agent: Claude Code]`, `[Agent: Antigravity]`, `[Agent: OpenCode]`).
   - **Lintas Sesi:** Sesi yang dibuka hari ini dapat membaca semua catatan dari sesi kemarin.
   - **Lintas Agent:** Pekerjaan yang dilakukan oleh Claude Code langsung terbaca saat Anda membuka project yang sama di Antigravity atau OpenCode.

3. **Lifecycle Hooks Terpadu:**
   - **Start / Check:** Saat sesi dibuka atau sebelum giliran prompt dimulai, sistem mengambil memori terbaru project tersebut (maks. 5 ringkasan sesi + 10 perubahan terbaru, ditambah fakta hasil ekstraksi server) dan menginjeksinya ke konteks prompt (`<supermemory-context>`). Memori dari agent lain langsung terbaca tanpa menunggu proses embedding selesai. Blok `<supermemory-context>` yang dikutip ulang oleh agent otomatis dibuang sebelum disimpan, jadi konteks tidak menumpuk berlapis.
   - **Change Observation:** Setiap kali ada modifikasi file atau eksekusi tool, perubahannya dicatat ke Supermemory.
   - **Stop / Session End:** Saat sesi berhenti atau idle, ringkasan sesi disimpan ke Supermemory untuk referensi di sesi berikutnya.

4. **Pembersihan Bersih & Bebas Konflik:**
   - Sepenuhnya menggantikan sistem memori lama seperti `claude-mem` dan `mem0` (entri `claude-mem` di `~/.gemini/settings.json` dan `mcp_config.json` agy sudah dilepas).
   - Terintegrasi rapi tanpa konflik MCP (baik via mcpm maupun native configs).

---

## 📁 Struktur Project

```text
supermemory-local/
├── .env                     # Konfigurasi port, model embedding & LLM 9router, data dir, direct workflow
├── .env.example             # Template konfigurasi
├── package.json             # Scripts bun (runtime tanpa dependensi; devDependencies hanya types, tsc & prettier)
├── tsconfig.json            # Konfigurasi TypeScript (bun run typecheck)
├── prettier.config.ts       # Format kode (extends @irfnd/prettier-config), bun run format
├── bin/
│   ├── stack.ts             # Controller stack: start, stop, restart, status, logs (9router, komponen memori, mcpm-gateway)
│   ├── supermemory-hook.ts  # Entrypoint hook CLI serbaguna untuk semua agent
│   ├── supermemory-mcp.ts   # Entrypoint server MCP stdio (search, add, profile)
│   ├── link-projects.ts     # Menautkan clone dari remote yang sama ke registri (bun run link-projects)
│   └── sessions-ui.ts       # Entrypoint halaman daftar sesi Claude Code (bun run sessions)
├── data/                    # Log + database lokal
│   ├── projects.json        # Registri clone yang berbagi memori (remote → tag tulis + tag baca lain)
│   ├── stores/<model>-<dim>d/ # Satu database per model embedding (api-key, embedding-plan.json, models/ untuk model lokal, ...)
│   ├── current -> stores/…  # Symlink ke store aktif (dibuat run.sh)
│   ├── supermemory.log      # Log runtime server
│   ├── llm-proxy.log        # Log proxy LLM (status & durasi per request)
│   ├── zed-adapter.log      # Log adapter Zed
│   ├── sessions-trash/      # Sesi Claude yang dihapus lewat Sessions UI (bisa di-restore)
│   ├── opencode-trash/      # Backup (JSON) sesi OpenCode yang dihapus lewat Sessions UI (bisa di-restore)
│   ├── sessions-meta.json   # Nama & tag sesi (sidecar, transkrip tidak diubah)
│   └── sessions-ui.log      # Audit tiap aksi Sessions UI (disetujui/ditolak/kedaluwarsa)
├── scripts/
│   ├── run.sh               # Menjalankan satu komponen di foreground (dipakai LaunchAgent & untuk debugging)
│   └── env.sh               # Konfigurasi run.sh: memuat .env lalu eval `bun src/config.ts --shell` (tidak ada salinan default sendiri)
└── src/
    ├── config.ts            # Satu-satunya tempat semua setting dan default-nya (port, URL, model, data dir, ignore)
    ├── stack.ts             # Logika controller stack: LaunchAgent, urutan start/stop, stop 9router yang aman, status, log
    ├── health.ts            # Parser murni untuk status: aktivitas hook per agent, gagal-muat plugin OpenCode, gagal ekstraksi
    ├── hook-handler.ts      # Handler lifecycle inti (start, sync, change, stop, compact), tidak tahu format agent
    ├── agents/              # Satu adapter per agent (claude-code, antigravity, opencode): parse payload → HookEvent, render stdout
    │   └── fixtures/        # Payload asli hasil tangkapan dari agent, dipakai sebagai contract test
    ├── project-resolver.ts  # Identitas project: root Git, registri clone, folder kumpulan repo, ignore
    ├── link-projects.ts     # Perencanaan penautan clone dari dokumen yang sudah tersimpan (fungsi murni)
    ├── supermemory-client.ts# Client API HTTP lokal
    ├── installer.ts         # Pasang/copot hooks ke agent CLIs (Claude, Antigravity, OpenCode)
    ├── opencode-plugin.ts   # Plugin OpenCode v2 (template; menjalankan hook sebagai subprocess)
    ├── llm-proxy.ts         # Proxy supermemory → 9router (stream:false di chat, dimensions di embeddings)
    ├── zed-adapter.ts       # Adapter Zed edit prediction: /v1/completions → 9router /chat/completions
    ├── mcp-server.ts        # Server MCP: JSON-RPC stdio tanpa SDK + tool search, add, profile
    ├── sessions-scan.ts     # Sessions UI: baca ~/.claude (read-only), sesi live, tautan memori
    ├── sessions-actions.ts  # Sessions UI: antrean persetujuan terminal, soft delete/restore/purge, nama & tag
    ├── sessions-other.ts    # Sessions UI: daftar sesi OpenCode & Antigravity (SQLite, dibuka read-only)
    ├── opencode-cli.ts      # Sessions UI: pembungkus `opencode session export|delete|import` + deteksi proses OpenCode
    ├── sessions-server.ts   # Sessions UI: server HTTP localhost + penjaga Host/Origin/token
    ├── sessions-page.ts     # Sessions UI: halaman HTML (tanpa resource eksternal)
    ├── hooks.test.ts        # Unit test (bun test)
    ├── agents/agents.test.ts# Contract test adapter agent dengan payload asli
    ├── sessions*.test.ts    # Unit test Sessions UI
    └── test-memory.ts       # Script verifikasi pembacaan & penulisan memori
```

---

## 🚀 Panduan Penggunaan Cepat

### 1. Konfigurasi (`.env`)

`.env` adalah **satu-satunya file yang kamu edit**. Setiap setting beserta defaultnya didefinisikan sekali di `src/config.ts`, dibaca dengan cara yang sama oleh hook, layanan, skrip shell (`scripts/env.sh` memanggil `bun src/config.ts --shell`) dan controller stack, dan `bun run status` menampilkan nilai efektifnya (tanpa API key). Konfigurasi yang ditulis installer ke agent hanya berisi perintah hook, tidak pernah port, URL, model, atau key, jadi mengubah `.env` tidak perlu memasang ulang hook.

File `.env` sudah diinisialisasi dengan konfigurasi default:

```ini
PORT=6767
SUPERMEMORY_PORT=6767
SUPERMEMORY_DATA_DIR=./data   # log + data/stores/<model>-<dim>d per model embedding
WORKFLOW_ENGINE=direct

# Embeddings lokal (bahasa Inggris saja) + terjemahan otomatis
SUPERMEMORY_EMBEDDING_PROVIDER=local
SUPERMEMORY_EMBEDDING_MODEL=Xenova/bge-base-en-v1.5
SUPERMEMORY_EMBEDDING_DIMENSIONS=768
TRANSLATE_MODEL=ag/gemini-3.8-flash-low   # model chat 9router untuk menerjemahkan ke bahasa Inggris; kosong = mati

# 9router Gateway (Local OpenAI-compatible API)
OPENAI_BASE_URL=http://127.0.0.1:20128/v1
OPENAI_API_KEY=<your-9router-api-key>
OPENAI_MODEL=ag/gemini-3.8-flash-low   # LLM ekstraksi memori (butuh JSON + tool calling)

# Supermemory Client API (dipakai hooks)
SUPERMEMORY_API_URL=http://127.0.0.1:6767
SUPERMEMORY_API_KEY=sm_local_key   # placeholder: client memakai data/current/api-key buatan server

# 9router
NINEROUTER_PORT=20128
NINEROUTER_HOST=127.0.0.1

# Proxy supermemory → 9router ("stream": false di chat, `dimensions` di embeddings)
LLM_PROXY_PORT=20129

# Adapter Zed edit prediction (pakai OPENAI_BASE_URL + OPENAI_API_KEY di atas)
ZED_ADAPTER_PORT=20130
ZED_ADAPTER_REASONING_EFFORT=none

# Folder yang diabaikan semua hook (regex terhadap folder kerja): tidak ada recall dan tidak ada yang disimpan
SUPERMEMORY_IGNORE="Library/Application Support|^/private/tmp|^/tmp"   # pakai tanda kutip: .env di-source oleh bash
```

> **Catatan Model:** Ekstraksi memori butuh model yang benar-benar menjawab JSON dan tool calling lewat 9router. Model yang menunjuk ke combo dengan anggota mati (`model not found`) atau yang timeout membuat dokumen berstatus `failed`; `bun run status` menampilkan persentase panggilan LLM yang gagal dan memberi peringatan di atas 10%. `supermemory-server doctor` juga bisa memeriksa modelnya. Server harus berjalan lewat `llm-proxy` (otomatis dari `bun run start`): tanpa proxy, 9router membalas dalam format streaming dan semua dokumen berakhir `failed` dengan error "Invalid JSON response". Untuk mengganti model, lihat [Mengganti Model](#mengganti-model).

---

### 2. Menjalankan Server

Butuh [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`). Pasang devDependencies sekali (`bun install`), lalu gunakan script bun atau bash langsung:

```bash
# Nyalakan seluruh stack: 9router (kalau belum menjawab), llm-proxy, zed-adapter, Supermemory Server, lalu mcpm-gateway
bun run start
```

Setelah itu komponen memori menyala otomatis saat login dan di-restart oleh launchd kalau crash (label `com.supermemory-local.server`, `.llm-proxy`, `.zed-adapter`). 9router (`com.9router.autostart`) dan mcpm-gateway (`com.mcpm.gateway`) punya LaunchAgent sendiri. `bun run start` hanya menyalakan keduanya kalau belum jalan: 9router lewat LaunchAgent-nya, gateway lewat `gateway.sh start`. Kalau 9router tetap tidak menjawab, start memberi peringatan dan tetap melanjutkan komponen lain.

Cek status layanan (exit `0` hanya kalau API memori & proxy LLM menjawab, jadi bisa dipakai sebagai health check). Status juga menampilkan 9router, port & LaunchAgent gateway, serta profil dan daftar server di `servers.yaml` gateway. Bagian **Agent integrations** menunjukkan kapan hook tiap agent terakhir jalan, apakah plugin OpenCode gagal dimuat setelah dipasang, dan berapa persen panggilan LLM ekstraksi yang gagal; bagian **Effective configuration** menunjukkan port dan model yang berlaku. Keduanya tidak memengaruhi exit code:

```bash
bun run status
```

Perintah lainnya:

```bash
bun run stop      # hentikan gateway lalu komponen memori; 9router tetap jalan (dipakai langsung oleh OpenCode & Zed)
bun run restart   # stop lalu start komponen memori saja (dipakai setelah mengubah .env); gateway tidak di-restart
bun run logs      # tail log komponen memori, gateway, dan 9router
```

`start`, `stop` dan `restart` menerima pemilih komponen, boleh digabung:

```bash
bun run stop --gateway             # hanya gateway
bun run stop --gateway --9router   # gateway dan 9router, komponen memori tetap jalan
bun run start --memory             # hanya komponen memori
bun run stop --all                 # semuanya, termasuk 9router
bun run start --9router            # nyalakan lagi 9router
```

Urutan start selalu 9router → komponen memori → gateway, dan urutan stop kebalikannya. Flag yang salah ketik (mis. `--9routr`) ditolak dengan exit `2` sebelum ada yang disentuh. Menghentikan gateway membuat tool MCP hilang dari sesi agent yang sedang terbuka sampai tersambung ulang (`/mcp`). `stop --9router` hanya mengirim SIGTERM ke proses LaunchAgent 9router dan turunannya (termasuk `next-server` yang memegang port 20128), tidak pernah SIGKILL, dan LaunchAgent-nya tetap terpasang sehingga 9router menyala lagi saat login.

Lokasi mcpm-gateway diatur dengan `MCPM_GATEWAY_DIR` di `.env` (default `../mcpm-gateway`, path relatif terhadap root repo ini). Kalau di sana tidak ada `gateway.sh`, semua langkah gateway dilewati dengan satu baris info.

Untuk debugging, hentikan layanan lalu jalankan satu komponen di foreground dengan konfigurasi yang sama:

```bash
bun run stop --memory
./scripts/run.sh server   # atau: llm-proxy, zed-adapter
```

`bun run start` menolak jalan kalau port komponen memori atau gateway dipakai proses lain, dan menyebutkan port serta prosesnya.

Untuk melepas auto-start komponen memori sepenuhnya: `bun run stop --memory && rm ~/Library/LaunchAgents/com.supermemory-local.*.plist`.

---

### 3. Tes Simpan & Cari Memori

Jalankan script verifikasi untuk memastikan Supermemory lokal dan 9router berfungsi:

```bash
bun run test-memory
```

Script memakai container tag terpisah (`<tag>_selftest`) sehingga catatan uji tidak mencemari memori project asli, dan keluar dengan exit code 1 jika gagal. Output akan menguji:

1. Status koneksi ke `http://127.0.0.1:6767`
2. Identifikasi tag unik project (`proj_<name>_<hash>`)
3. Penyimpanan konten memori baru
4. Pencarian semantik (vektor) dari database lokal

---

### 4. Instalasi Hooks ke Agent CLI

Jalankan script instalasi hooks:

```bash
# Pasang ke semua agent (Claude Code, Antigravity, OpenCode):
bun run install-hooks

# Atau pasang per agent:
bun run install-hooks claude-code
bun run install-hooks antigravity
bun run install-hooks opencode
```

> **Catatan Keamanan:** Setiap file konfigurasi yang diubah (`~/.claude/settings.json`, `~/.gemini/config/hooks.json`, `~/.config/opencode/opencode.json`) secara otomatis dibuatkan backup bertanda `.bak-<timestamp>` sebelum dimodifikasi.

Jika ingin mencopot hooks kembali:

```bash
bun run uninstall-hooks
```

---

## 🔍 Cara Kerja Tiap Hook

### A. Claude Code (`~/.claude/settings.json`)

- **`SessionStart`** (matcher `startup|resume|clear|compact`): Mengeksekusi `bun --env-file=<repo>/.env bin/supermemory-hook.ts claude-code start`. Memori relevan project (terbaru dulu) diambil dan disajikan sebagai bagian dari konteks percakapan. Fakta hasil ekstraksi server (`/v4/profile`: semua `static` + 15 `dynamic` terbaru) ikut ditambahkan.
- **`UserPromptSubmit`**: Mengeksekusi `claude-code sync` di setiap prompt. Hanya memori baru dari agent/sesi lain sejak konteks terakhir yang disuntikkan (marker per sesi di `$TMPDIR/supermemory-sync/`), jadi sesi yang lama terbuka tetap sinkron. Selain itu, isi prompt (diterjemahkan dulu ke bahasa Inggris lewat `TRANSLATE_MODEL` jika perlu) dipakai sebagai query hybrid search (`/v4/search`, `searchMode: "hybrid"`): memori hasil ekstraksi yang relevan ditambah maksimal 2 potongan dokumen mentah (untuk dokumen yang ekstraksinya belum selesai). Prompt 1–2 kata ("ya", "lanjut") dilewati, dan setiap hasil hanya disuntikkan sekali per sesi.
- **`PostToolUse`** (matcher `Write|Edit|MultiEdit|NotebookEdit|Bash`): Mencatat nama tool + path file (`tool_name`, `tool_input.file_path`) atau command Bash ke Supermemory. Command read-only (`ls`, `cat`, `git status`, dll.) diabaikan.
- **`Stop`**: Menyimpan balasan terakhir asisten (`last_assistant_message`, fallback ke `transcript_path`) sebagai ringkasan, maks. 4000 karakter. Ringkasan yang bukan bahasa Inggris diterjemahkan dulu lewat `TRANSLATE_MODEL`.
- **`PostCompact`**: Setelah `/compact` atau auto-compact, `claude-code compact` mengambil ringkasan compaction terakhir dari `transcript_path` (entry `isCompactSummary`), membuang pembuka/penutup instruksinya, lalu menyimpannya sebagai `session_summary` (maks. 40.000 karakter).

### B. Antigravity (`~/.gemini/config/hooks.json`)

- **`SessionStart`**: Mengeksekusi `supermemory-hook.ts antigravity start`. Memori project disuntikkan **sekali** sebagai `systemMessage` yang bertahan di percakapan (`{ "injectSteps": [{ "systemMessage": { "systemMessage": "<supermemory-context>..." } }] }`).
- **`PreInvocation`**: Mengeksekusi `antigravity sync`. Hook ini dipanggil sebelum **setiap panggilan model**, tetapi adapter hanya bekerja pada panggilan pertama tiap giliran user (`invocationNum` bernilai 0). Saat itu yang disuntikkan hanya memori baru dari agent/sesi lain plus hasil pencarian untuk `lastUserInput`. Panggilan model berikutnya dalam giliran yang sama mendapat `{}`.
- **`PostToolUse`** (matcher `write_to_file|replace_file_content|run_command`): Mencatat eksekusi tool ke Supermemory dan mengembalikan `{}`. Command read-only (`ls`, `cat`, `git status`, dll.) diabaikan agar memori tidak penuh noise.
- **`Stop`**: Payload `Stop` agy tidak membawa teks balasan, jadi adapter membaca entri `PLANNER_RESPONSE` terakhir dari `transcriptPath` (`transcript_full.jsonl`) dan menyimpannya sebagai `session_summary` (maks. 4000 karakter; diterjemahkan lewat `TRANSLATE_MODEL` jika perlu). Hanya untuk akhir giliran normal (`terminationReason: NO_TOOL_CALL`); giliran yang dibatalkan atau error tidak disimpan.
- Antigravity tidak punya hook compaction, jadi ringkasan compaction-nya tidak bisa ditangkap.

#### Menyambungkan ke `agy` (Antigravity CLI)

Ringkasan hook yang dipasang installer di `~/.gemini/config/hooks.json` (satu entri bernama `supermemory-local`, `enabled: true`, timeout 15 detik per hook):

| Event agy       | Matcher                                            | Action               | Stdout                                                                                                                          |
| --------------- | -------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `SessionStart`  | -                                                  | `antigravity start`  | `{"injectSteps":[{"systemMessage":{"systemMessage":"<supermemory-context>…"}}]}`, atau `{}` jika belum ada memori / server mati |
| `PreInvocation` | semua                                              | `antigravity sync`   | sama, hanya pada panggilan model pertama tiap giliran; selain itu `{}`                                                          |
| `PostToolUse`   | `write_to_file\|replace_file_content\|run_command` | `antigravity change` | selalu `{}`                                                                                                                     |
| `Stop`          | semua                                              | `antigravity stop`   | selalu `{}`                                                                                                                     |

Perintah yang dijalankan tiap hook (path absolut, ditulis installer):

```bash
"<bun>" --env-file="<repo>/.env" "<repo>/bin/supermemory-hook.ts" antigravity <start|sync|change|stop>
```

Catatan:

- Hook agy berjalan **sinkron dan memblokir agent**, jadi setiap panggilan yang lambat (misalnya terjemahan yang timeout) langsung terasa. Sebelumnya `start` penuh dijalankan di setiap panggilan model dan setiap blok ikut tersimpan di percakapan (satu percakapan sempat berisi 454 blok, ±2,5 juta karakter); sekarang satu percakapan berisi satu blok penuh plus update kecil.
- `SessionStart` tidak dipanggil saat percakapan di-resume (`agy --conversation <id>`). Giliran pertama setelah resume mendapat `sync`, dan kalau marker sesi hilang, `sync` otomatis menjadi `start` penuh.
- Hook lain di file yang sama (mis. entri `zentty`) tidak diubah installer; installer hanya mengganti entri `supermemory-local`. File di-backup ke `hooks.json.bak-<waktu>` sebelum ditulis.
- Hook dibaca saat sesi agy dimulai: buka sesi baru setelah memasang. Server memori harus berjalan (`bun run status`), kalau tidak hook mengembalikan `{}`.
- Payload yang dibaca: `conversationId` (id sesi), `cwd`/`workspacePaths[0]` (folder project), `lastUserInput` (prompt), `invocationNum`, `terminationReason`, `transcriptPath`, dan `toolCall.{name,args}` (`TargetFile`, `CommandLine`, `Description`). Tool `view_*`, `read_*`, `search_web`, `schedule` dan command read-only diabaikan. Contoh payload asli ada di `src/agents/fixtures/antigravity/`.

```bash
bun run install-hooks antigravity     # pasang / pasang ulang
bun run uninstall-hooks antigravity   # copot

# tes manual tanpa agy (tampilkan konteks yang akan disuntikkan, lalu cek log):
echo '{"cwd":"'$PWD'"}' | bun --env-file=.env bin/supermemory-hook.ts antigravity start
grep -i antigravity ~/.supermemory-hook.log | tail
```

Jika setelah sesi agy berjalan tidak ada baris `agent=antigravity` baru di log, hook belum dipanggil: cek `~/.gemini/config/hooks.json` (harus ada `supermemory-local`), path `bun` di perintah masih valid, dan sesi agy dibuka ulang.

### C. OpenCode (`~/.config/opencode/plugins/supermemory-local.ts`)

- Plugin di-generate dari `src/opencode-plugin.ts` dan otomatis ter-load dari folder plugins global (tidak perlu, dan jangan, didaftarkan di `opencode.json` karena akan ter-load dua kali). Zentty menyalin plugin saat panel dibuka, jadi buka ulang panel OpenCode di Zentty setelah memasang.
- Formatnya **OpenCode v2**: objek `{ id, setup(ctx) }` yang di-export default, tanpa import paket. Plugin versi lama (v1, `export const X: Plugin = async () => ({...})`) gagal dimuat di OpenCode v2 dengan pesan "Plugin must export a default definition", sehingga OpenCode tidak menyimpan dan tidak membaca memori sama sekali. `bun run status` sekarang melaporkan kegagalan seperti itu.
- Plugin hanya jembatan tipis: setiap keputusan memori dijalankan oleh `bin/supermemory-hook.ts` sebagai subprocess (batas 15 detik, kegagalan diabaikan), jadi konfigurasi, isolasi error, dan aturan "jangan pernah memblokir agent" sama dengan agent lain. Service v2 dipakai bersama oleh semua project, jadi folder kerja dibaca per sesi lewat `ctx.session.get()`, bukan dari lokasi plugin.
- Hook yang dipakai:
  - `session.hook("prompt")`: Menjalankan `start` pada prompt pertama sesi, lalu `sync` pada tiap prompt berikutnya (memori baru dari agent/sesi lain plus hasil pencarian untuk teks prompt, sama seperti Claude Code).
  - `session.hook("context")`: Menaruh blok memori yang sudah diambil ke `system` di setiap permintaan model (tanpa subprocess).
  - `tool.hook("execute.after")`: Mencatat tool execution ke memori (tool read-only dan command shell read-only diabaikan). Tool shell di v2 bernama `shell`.
  - Event `session.execution.succeeded`: Menyimpan balasan asisten terakhir (dibaca lewat `ctx.session.context()`) sebagai `session_summary`.
  - Event `session.compaction.ended`: Menyimpan ringkasan compaction (string `summary` pada item `compaction` terbaru dari `ctx.session.context()`) sebagai `session_summary`. Teruji di OpenCode sungguhan lewat `POST /api/session/{id}/compact`; compaction tidak ikut tersimpan lagi sebagai balasan biasa.
- Model default OpenCode kamu di 9router harus bisa menjawab, kalau tidak giliran gagal sebelum plugin sempat menyimpan ringkasan. Hook `prompt`, `context`, dan `execute.after` tidak bergantung pada itu.

---

## 🧭 Identitas Project, Clone Bersama, dan Folder Kumpulan Repo

Hook dan server MCP memakai aturan yang sama (`src/project-resolver.ts`) untuk menentukan memori mana yang dipakai di sebuah folder:

| Folder kerja                                                                                  | Memori yang dipakai                                                                                                                                                     |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Di dalam repo Git (folder mana pun di dalamnya)                                               | Memori repo itu                                                                                                                                                         |
| Repo yang punya remote `origin`, ada lebih dari satu clone / worktree                         | **Satu memori bersama**: semua clone menulis ke satu tag dan membaca juga memori lama tiap clone                                                                        |
| Folder non-Git tanpa repo di dalamnya (mis. folder dokumen)                                   | Memori folder itu sendiri                                                                                                                                               |
| Folder non-Git yang berisi repo sampai dua tingkat (`~/dev/personal`, `kita-pgd`) dan `$HOME` | **Bukan project.** Agent hanya mendapat satu baris petunjuk bahwa memori per repo. Perubahan file tetap dicatat ke repo pemilik file itu; ringkasan sesi tidak disimpan |
| Cocok dengan `SUPERMEMORY_IGNORE`                                                             | Dilewati total (tidak recall, tidak menyimpan)                                                                                                                          |

**Kenapa clone bisa berbagi tanpa memindahkan data.** Server memori tidak bisa mengganti container tag dokumen yang sudah ada (`PATCH /v3/documents/:id` mengabaikan `containerTags`, dan `POST /v3/container-tags/merge` gagal di mode `WORKFLOW_ENGINE=direct`). Menambah ulang dokumen berarti ekstraksi ulang ribuan dokumen. Jadi tag setiap repo **tidak berubah**, dan clone dari remote yang sama dicatat di `data/projects.json`:

```json
{ "repo.example/tim/app": { "tag": "proj_app_eb272b", "also": ["proj_app_7185a4"] } }
```

Clone menulis memori baru ke `tag` dan membaca `tag` ditambah semua `also`, sehingga tidak ada memori lama yang hilang. Repo yang baru pertama kali terlihat mendaftar sendiri (clone pertama menjadi tag tulis). Remote dinormalisasi, jadi `https://user:token@Repo.X/a/b.git`, `ssh://git@repo.x:22/a/b`, dan `git@repo.x:a/b.git` dianggap sama. Registri yang hilang atau rusak hanya berarti tidak ada berbagi; hook tetap jalan.

Untuk clone yang **sudah** menyimpan memori sebelumnya, isi registri dari dokumen yang ada sekali saja:

```bash
bun run link-projects            # dry run: daftar kelompok clone beserta jumlah dokumennya
bun run link-projects --apply    # tulis data/projects.json
```

Tag dengan dokumen terbanyak menjadi tag tulis, entri yang sudah ada tidak pernah diganti (hanya ditambah), dan perintah ini hanya membaca store: tidak ada dokumen yang diubah, aman diulang, dan dibatalkan dengan menghapus `data/projects.json`.

---

## ✏️ Zed Edit Prediction (via `zed-adapter`)

Provider `open_ai_compatible_api` di Zed mengirim format legacy `/v1/completions` (`{"prompt": ...}`), sedangkan 9router hanya punya `/chat/completions`. Tanpa adapter, `prompt` diabaikan, `messages` kosong, dan Gemini menolak dengan `400 contents is not specified`. `bun run start` menjalankan `src/zed-adapter.ts` di port `ZED_ADAPTER_PORT` (default `20130`) memakai `OPENAI_BASE_URL` & `OPENAI_API_KEY` dari `.env` (header Authorization dari Zed hanya dipakai jika key di `.env` kosong).

Adapter mengirim `reasoning_effort` dari `ZED_ADAPTER_REASONING_EFFORT` (default `none`), lalu merapikan output model chat: membuang pembungkus ` ``` `, menerapkan `stop` secara lokal (Gemini membatasi 5 stop sequence), dan menambahkan kembali marker zeta `<|editable_region_start|>`/`<|editable_region_end|>` jika hilang.

```json
"edit_predictions": {
  "provider": "open_ai_compatible_api",
  "open_ai_compatible_api": {
    "api_url": "http://127.0.0.1:20130/v1/completions",
    "model": "ag/gemini-3.8-flash-low",
    "prompt_format": "zeta"
  }
}
```

> Pakai model tanpa thinking berat. `ag/gemini-3.8-flash-low` sekitar 3 detik per prediksi; varian `*-high` (mis. combo `pecut-ai`) 22–34 detik.

---

## 🔌 Server MCP (search, add, profile)

Selain lewat hook, memori bisa diakses langsung oleh client MCP apa pun, misalnya lewat gateway mcpm. `bin/supermemory-mcp.ts` adalah server MCP stdio, dijalankan oleh client-nya (bukan LaunchAgent):

```bash
bun --env-file=/path/ke/supermemory-local/.env /path/ke/supermemory-local/bin/supermemory-mcp.ts
```

| Tool      | Argumen                                                | Fungsi                                                                                                        |
| --------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `search`  | `project_path`, `query`, `limit` (opsional, default 6) | Mencari memori & cuplikan dokumen project. Query non-Inggris diterjemahkan dulu.                              |
| `add`     | `project_path`, `content`                              | Menyimpan catatan ke memori project (`metadata.agent = "MCP"`, `type = "note"`) dan mengembalikan ID dokumen. |
| `profile` | `project_path`                                         | Fakta jangka panjang & terbaru yang diekstrak server untuk project.                                           |

`project_path` wajib path absolut yang ada, boleh folder apa pun di dalam repo. Project-nya ditentukan sama seperti hook, jadi agent lewat MCP dan lewat hook memakai memori yang sama, termasuk memori clone lain dari remote yang sama (`search` dan `profile` membaca semua tag clone, `add` menulis ke tag bersama). Folder yang hanya berisi banyak repo, `$HOME`, atau folder yang diabaikan `SUPERMEMORY_IGNORE` ditolak dengan error yang menyebut repo di dalamnya.

Kalau server memori mati, tool mengembalikan error dan proses MCP tetap hidup, lalu kembali normal begitu server menyala lagi. Log error ada di `~/.supermemory-hook.log`.

---

## 🗂️ Sessions UI (daftar sesi Claude Code, OpenCode, Antigravity)

Halaman lokal untuk melihat semua sesi Claude Code di Mac ini (dari `~/.claude/projects`), dikelompokkan per project: judul, branch, waktu, ukuran, file yang diubah, PR, biaya, badge **live** untuk sesi yang sedang berjalan, dan memori supermemory yang ditulis sesi itu (dicocokkan lewat `metadata.session`).

```bash
bun run sessions        # buka http://127.0.0.1:20131 (port: SESSIONS_UI_PORT di .env)
```

Jalankan di terminal biasa dan biarkan terbuka: server berjalan di **foreground** dan tidak dijalankan oleh `bun run start`. Tanpa terminal interaktif server menolak start.

**Persetujuan.** Browser hanya bisa _meminta_ aksi (hapus, restore, purge, ubah nama, tag). Aksi baru jalan setelah kamu menjawab `y` di terminal tempat server berjalan; tidak ada route HTTP yang bisa menyetujui, jadi halaman web lain atau agent yang memanggil `curl` tidak bisa menyetujui sendiri. Permintaan kedaluwarsa setelah 5 menit. Untuk hapus dan purge, browser juga meminta kamu mengetik 8 karakter pertama id sesi.

- **Hapus = soft delete.** Transkrip, folder `<id>/` dan `~/.claude/file-history/<id>/` dipindah ke `data/sessions-trash/`; bisa di-_restore_ (ditolak jika ada file yang sudah ada di tujuan) atau di-_purge_ permanen. Sesi yang sedang live tidak bisa dihapus. Ada opsi terpisah (default mati) untuk ikut menghapus catatan supermemory sesi itu; catatan yang masih diproses (409) dilaporkan sebagai gagal tanpa membatalkan pemindahan file.
- **Nama & tag** disimpan di `data/sessions-meta.json`. File transkrip tidak pernah diubah.
- **Resume / sesi baru**: tombol _Copy_ menyalin perintah `cd <dir> && claude --resume <id>` (server tidak menjalankannya).
- **Tab OpenCode & Antigravity.** Selain tab _Claude Code_, halaman punya tab **OpenCode** (dari `~/.local/share/opencode/opencode.db`, atau `$XDG_DATA_HOME/opencode/`; tabel `session_v2`, atau `session` untuk OpenCode lama) dan **Antigravity** (dari `~/.gemini/antigravity-cli/conversation_summaries.db`), dikelompokkan per folder kerja. Sesi sub-agent OpenCode, sesi yang di-archive, dan percakapan `agy` tanpa langkah disembunyikan (jumlahnya ditampilkan). Database keduanya dibuka `mode=ro` untuk membaca.
  - **Rename & Tags** untuk OpenCode dan Antigravity: disimpan di `data/sessions-meta.json` (kunci `opencode:<id>` / `antigravity:<id>`), tidak menyentuh database mereka. Tetap perlu `y` di terminal.
  - **Delete untuk OpenCode** (tidak ada untuk Antigravity). Server tidak pernah menulis SQL ke database OpenCode, karena database itu berisi dua generasi tabel (`session` dan `session_v2` beserta pesan dan event-nya) yang hanya dijaga konsisten oleh OpenCode sendiri. Urutannya: (1) tolak jika ada proses OpenCode berjalan (dicek saat permintaan dan sekali lagi tepat sebelum eksekusi); (2) `opencode session export` untuk sesi dan **semua sesi sub-agent-nya** (CLI ikut menghapus anak-anaknya), ditulis ke `data/opencode-trash/<ts>_<id>.json` (izin `600`, berisi transkrip) dan dibaca ulang; (3) baru `opencode session delete --standalone`; (4) diperiksa bahwa sesi benar-benar hilang dari OpenCode. Gagal di langkah mana pun tidak menghilangkan apa pun, dan backup yang sudah ditulis tidak dihapus oleh jalur gagal.
  - **Restore & Purge** ada di tab _Trash_ (entri bertanda OpenCode): restore menjalankan `opencode session import` (induk dulu, id sama; waktu _updated_ jadi waktu restore) dan baru menghapus backup setelah semua sesi terbukti kembali. Restore yang setengah jalan bisa diulang: hanya sesi yang masih hilang yang diimpor. Purge menghapus file backup secara permanen.
  - Tombol _Copy resume_ ada untuk OpenCode (`cd <dir> && opencode --session <id>`); `agy` belum karena perintah resume-nya belum diketahui. Kotak search berlaku di semua tab; filter project, urutan, dan _live only_ hanya untuk Claude Code.
  - Binary yang dipakai adalah `opencode` asli pertama di `PATH` (wrapper shell Zentty dilewati); ganti dengan `OPENCODE_BIN` bila perlu.
- Server hanya mendengarkan `127.0.0.1`, menolak `Host`/`Origin` asing, dan mewajibkan token acak per-run. Teks transkrip tidak dikirim ke mana pun (hanya id sesi ke server memori lokal).

---

## 🛠️ Pemeliharaan & Reset Data

### Membersihkan Data Testing

Jika ingin mengosongkan riwayat memori model embedding yang sedang aktif:

1. Hentikan server:
   ```bash
   bun run stop
   ```
2. Hapus store aktif beserta marker sesi hook:
   ```bash
   rm -rf "./data/$(readlink ./data/current)" "${TMPDIR}supermemory-sync"
   ```
   Untuk mengosongkan semua model sekaligus: `rm -rf ./data/stores ./data/current "${TMPDIR}supermemory-sync"`.
3. Nyalakan kembali server:
   ```bash
   bun run start
   ```

### Mengganti Model

Semua model diatur di `.env`, dan setiap penggantian cukup diikuti `bun run restart`. Tanpa restart, proses yang sedang berjalan tetap memakai `.env` versi lama.

#### Model embedding (`SUPERMEMORY_EMBEDDING_*`)

Server mengunci folder data ke provider, model, dimensi, dan endpoint yang pertama mengisinya (`embedding-plan.json`), lalu menolak start (`Embedding model mismatch`) kalau `.env` berbeda. Karena itu `scripts/run.sh` memakai satu store per model di `data/stores/<model>-<dim>d/`. Mengganti model tidak menghapus apa pun: model baru mendapat store kosong, dan kembali ke model lama membuka store lamanya lagi. Memori tidak dibagi antar model, karena embedding dari model berbeda tidak bisa dibandingkan.

1. Cek dimensi model baru lewat 9router. Hasilnya harus ≤ 2000, dan model harus menghormati `dimensions`:
   ```bash
   set -a; source .env; set +a
   curl -s http://127.0.0.1:20128/v1/embeddings -H "Authorization: Bearer $OPENAI_API_KEY" \
     -H 'Content-Type: application/json' \
     -d '{"model":"<model-baru>","input":"tes","dimensions":1024}' \
     | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["data"][0]["embedding"]))'
   ```
   Kalau hasilnya bukan 1024, model mengabaikan `dimensions`. Pakai dimensi aslinya (maksimal 2000) di `SUPERMEMORY_EMBEDDING_DIMENSIONS`.
2. Ubah `SUPERMEMORY_EMBEDDING_MODEL` (dan `SUPERMEMORY_EMBEDDING_DIMENSIONS` bila perlu) di `.env`.
3. Jalankan `bun run restart`, lalu pastikan baris `Storage:` dan `Embeddings:` di `bun run status` menunjuk ke model baru. Perintah itu juga menampilkan daftar semua store.
4. Opsional:
   - Hapus store model yang tidak dipakai lagi: `rm -rf ./data/stores/<nama-store>`.
   - Bawa memori lama ke model baru: ekspor dari store lama (`POST /v3/documents/list` lalu `GET /v3/documents/:id`) sebelum langkah 2, lalu masukkan ulang dengan `POST /v3/documents` setelah langkah 3. Ekstraksi ulang memakai kuota 9router sebanding dengan jumlah dokumen.

> Endpoint embedding (`http://127.0.0.1:$LLM_PROXY_PORT`) ikut terkunci, jadi mengganti `LLM_PROXY_PORT` membuat store yang ada menolak start. Kembalikan port-nya, atau hapus store tersebut.

#### Terjemahan (`TRANSLATE_MODEL`)

Model embedding yang hanya berbahasa Inggris (mis. `Xenova/bge-base-en-v1.5`) butuh `TRANSLATE_MODEL`, yaitu model chat 9router yang menerjemahkan prompt (`sync`) dan ringkasan sesi (`stop`) ke bahasa Inggris. Teks yang sudah berbahasa Inggris dilewati tanpa panggilan LLM. Catatan perubahan tool dan ringkasan compaction tidak diterjemahkan, karena memori hasil ekstraksi server sudah berbahasa Inggris. Kalau terjemahan gagal atau lewat batas waktu (8 detik untuk prompt, 12 detik untuk ringkasan), teks asli yang dipakai. Prompt berbahasa Indonesia jadi lebih lambat sekitar 1–2 detik **kalau model penerjemahnya cepat**. Hook agy memblokir agent, jadi model yang lambat atau timeout (8 detik per prompt) langsung terasa di setiap giliran berbahasa Indonesia; pilih model yang menjawab di bawah ±2 detik, atau kosongkan `TRANSLATE_MODEL` kalau pencarian per prompt untuk bahasa non-Inggris tidak penting.

- Ganti model penerjemah: ubah `TRANSLATE_MODEL` di `.env`. Hook membaca `.env` di setiap panggilan, jadi tidak perlu restart.
- Model embedding multibahasa (mis. Jina): kosongkan `TRANSLATE_MODEL=`.

#### Model LLM ekstraksi memori (`OPENAI_MODEL`)

Model ini tidak terkunci, dan memori lama tetap aman.

1. Pastikan model ada di 9router dan bisa membalas JSON:
   ```bash
   curl -s http://127.0.0.1:20128/v1/chat/completions -H "Authorization: Bearer $OPENAI_API_KEY" \
     -H 'Content-Type: application/json' \
     -d '{"model":"<model-baru>","stream":false,"response_format":{"type":"json_object"},"messages":[{"role":"user","content":"balas {\"ok\":true}"}]}'
   ```
2. Ubah `OPENAI_MODEL` di `.env`, lalu jalankan `bun run restart`. Store dan memori tidak berubah.
3. Cek `data/llm-proxy.log`: panggilan baru harus berstatus `200`, dan dokumen baru harus sampai ke status `done`.

#### Model edit prediction Zed, port, dan key

- **Model Zed:** ganti di pengaturan Zed. Adapter meneruskan `model` dari request apa adanya, jadi tidak perlu restart. `ZED_ADAPTER_REASONING_EFFORT` butuh `bun run restart`.
- **`NINEROUTER_PORT`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`:** cukup `bun run restart`. Kalau port atau key 9router sendiri berubah, restart juga 9router: `bun run restart --9router`.

### Menghapus Dokumen Satu Container Tag

Untuk membuang dokumen uji (misalnya dari menjalankan hook manual dengan `cwd` sementara) tanpa mereset seluruh memori, hapus per dokumen lewat `DELETE /v3/documents/:id`:

```bash
bun --env-file=.env -e '
import { SupermemoryClient } from "./src/supermemory-client.ts";
const c = new SupermemoryClient();
const tag = "proj_<nama>_<hash>"; // tag project; di log hook: "Project: <nama> (<path>)", tag selftest: "<tag>_selftest"
for (const d of await c.listDocuments({ containerTags: [tag], limit: 100 }))
  console.log(d.id, (await c.request("DELETE", `/v3/documents/${d.id}`)).error ?? "deleted");'
```

> Dokumen yang masih diproses (ekstraksi memori lewat 9router, bisa beberapa menit) ditolak dengan `HTTP 409: Document is still processing`. Tunggu sampai selesai, lalu jalankan ulang.

### Log & Debugging

- Log server supermemory: `./data/supermemory.log`
- Log proxy LLM (status & durasi tiap request ke 9router): `./data/llm-proxy.log`
- Log adapter Zed (model, status & durasi tiap prediksi): `./data/zed-adapter.log`
- Log aktivitas hook: `~/.supermemory-hook.log` (di **home directory**, bukan di folder repo; dipakai bersama oleh semua agent dan semua project)
- Log gateway 9router: `/tmp/9router.log` dan `/tmp/9router.error.log` (`StandardOutPath`/`StandardErrorPath` di LaunchAgent-nya)
- Log mcpm-gateway: `$MCPM_GATEWAY_DIR/logs/gateway.stdout.log` dan `gateway.stderr.log`
- Semua log di atas (kecuali hook) sekaligus: `bun run logs`
- Log Sessions UI (audit tiap aksi: disetujui, ditolak, kedaluwarsa): `./data/sessions-ui.log`

#### Panduan Menelusuri & Mendiagnosis Error (Trace Log Error)

Jika ada masalah atau komponen gagal menjawab saat menjalankan stack (`bun run start`, `bun run restart`, atau `bun run status`), ikuti panduan pelacakan error berikut berdasarkan lokasinya:

| Gejala / Masalah                                                             | File Log yang Diperiksa                                      | Pola Error yang Dicari                                                     | Penyebab & Solusi Umum                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Port Konflik / Preflight Gagal** (`❌ Port <p> is already in use by: ...`) | Output terminal langsung / `lsof -nP -iTCP:<p> -sTCP:LISTEN` | `Port <port> (...) is already in use`                                      | Ada proses lama atau zombie di luar launchd. Cek PID yang dilaporkan, hentikan proses tersebut dengan `kill <PID>`, lalu jalankan kembali `bun run start`.                                                                                                        |
| **Server Supermemory Gagal Binding / Crash**                                 | `./data/supermemory.log`                                     | `Failed to bind`, `embedding-plan.json mismatch`, `Address already in use` | 1. Jika model embedding di `.env` baru saja diubah dan mismatch dengan store lama, server menolak boot. Solusi: pastikan store aktif di `data/current` sesuai model baru.<br>2. Periksa apakah binary `supermemory-server` ada di `~/.supermemory/bin` atau PATH. |
| **Ekstraksi Memori Gagal / Berstatus `failed`**                              | `./data/llm-proxy.log` dan `./data/supermemory.log`          | `Invalid JSON response`, `HTTP 500`, `HTTP 400`, `timeout`                 | 1. Cek `./data/llm-proxy.log`: panggilan LLM harus mengembalikan status `200`. Jika `400` atau `500`, cek kuota/API key atau model di 9router (`OPENAI_MODEL`).<br>2. Pastikan proxy berjalan di port 20129 karena supermemory membutuhkan `"stream": false`.     |
| **Zed Edit Prediction Gagal**                                                | `./data/zed-adapter.log`                                     | `400 contents is not specified`, `connection refused`                      | 1. Periksa apakah 9router berjalan di port 20128.<br>2. Cek apakah model chat yang digunakan mendukung format completion.                                                                                                                                         |
| **9router Tidak Menjawab / Port 20128 Menolak**                              | `/tmp/9router.error.log` dan `/tmp/9router.log`              | `EADDRINUSE`, `next-server crash`, `SIGTERM`                               | Jika child `next-server` tertinggal atau port tertahan, gunakan `bun run stop --9router` untuk terminasi aman dari pohon prosesnya, lalu jalankan `bun run start --9router`.                                                                                      |
| **mcpm-gateway Tidak Terbuka / Tool Hilang**                                 | `$MCPM_GATEWAY_DIR/logs/gateway.stderr.log`                  | `Port 6276 already in use`, `Traceback`, `TIME_WAIT`                       | 1. `gateway.sh` membutuhkan waktu pembersihan socket `TIME_WAIT` (hingga 90 detik). Jika macet, jalankan `$MCPM_GATEWAY_DIR/gateway.sh restart`.<br>2. Cek apakah ada syntax error di `$MCPM_GATEWAY_DIR/servers.yaml`.                                           |
| **Hook Agent Gagal Menyimpan / Mengambil Memori**                            | `~/.supermemory-hook.log`                                    | `Save failed: HTTP`, `Translate failed`, `server is not responding`        | Hook dirancang `fail-open` (selalu exit 0 agar tidak memblokir agent). Buka `~/.supermemory-hook.log` untuk melihat alasan kegagalan HTTP atau timeout translasi LLM.                                                                                             |

#### Perintah Bantuan untuk Tracing Log:

```bash
# Pantau semua log stack secara realtime
bun run logs

# Filter pesan error pada seluruh log komponen lokal
grep -inE 'error|fail|exception|fatal|refused' data/*.log /tmp/9router.error.log 2>/dev/null | tail -n 30

# Filter error khusus pada hook semua agent
grep -E 'failed|error|not responding' ~/.supermemory-hook.log | tail -n 25

# Cek proses yang menahan port tertentu jika terjadi konflik (misal 6767, 20128, 20129, 6276)
lsof -nP -iTCP:6767 -sTCP:LISTEN
```

#### Log hook (`~/.supermemory-hook.log`)

Satu baris per kejadian, format `[waktu ISO UTC] pesan`. Hook sengaja tidak pernah menulis diagnostik ke stdout (stdout dipakai untuk menyuntikkan konteks), jadi log ini satu-satunya tempat melihat apa yang terjadi:

```text
Invoked: agent=antigravity, action=start          # hook dipanggil agent
Project: supermemory-local (/path/ke/project), Agent: Antigravity
Injected 33 context lines for project …           # konteks disuntikkan
Saving session_summary (Antigravity): …           # catatan dikirim ke server
Save failed: HTTP …  /  Translate failed (…)      # kegagalan (hook tetap exit 0, agent tidak terblokir)
No project for /path (start), Agent: …            # folder kumpulan repo / $HOME / diabaikan: tidak ada memori
Supermemory server is not responding at …         # server mati: konteks kosong
Hook error (agent action): …                      # exception tak terduga
```

```bash
tail -f ~/.supermemory-hook.log                    # pantau langsung
grep 'agent=antigravity' ~/.supermemory-hook.log | tail   # hanya agy (ganti dengan claude-code / opencode)
grep -E 'failed|error|not responding' ~/.supermemory-hook.log | tail   # hanya masalah
: > ~/.supermemory-hook.log                        # kosongkan (tidak ada rotasi otomatis, file terus membesar)
```

File lain yang dipakai hook: marker sinkronisasi per sesi di `$TMPDIR/supermemory-sync/<session>` (dan `<session>.seen`); hilang sendiri saat reboot.

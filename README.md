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
   - **Storage per Model Embedding:** Database lokal tersimpan di `./data/stores/<model>-<dim>d/`, satu store per model embedding, dan `./data/current` menunjuk ke store aktif. Server mengunci satu folder data ke model yang pertama mengisinya, jadi `start.sh` memilih (atau membuat) store milik model di `.env`. Mengganti model cukup ubah `.env` lalu restart, dan kembali ke model lama memulihkan memorinya. Lihat [Mengganti Model](#mengganti-model).
   - **Workflow Engine Direct:** Menggunakan `WORKFLOW_ENGINE=direct` sehingga proses ekstraksi dan relasi memori dieksekusi secara in-process langsung tanpa dependensi ke server worker eksternal.
   - **Model AI (LLM):** Ekstraksi memori memakai `OPENAI_MODEL` (mis. `ag/gemini-3.8-flash-low` atau `cc/claude-haiku-4-5-20251001`) lewat gateway lokal **9router** (`http://127.0.0.1:20128/v1`) dan proxy kecil `src/llm-proxy.ts` (port `20129`). Proxy ini menambahkan `"stream": false` ke request chat, karena supermemory tidak mengisi `stream` sedangkan 9router membalas dalam format streaming (SSE) jika `stream` kosong, yang membuat supermemory gagal mem-parsing JSON.

2. **Per-Project & Cross-Agent Shared Memory:**
   - Otomatis mendeteksi root repository Git (`git rev-parse --show-toplevel`) atau direktori kerja saat ini.
   - Setiap project memiliki `containerTag` unik (`proj_<folder>_<hash>`) yang dipakai bersama oleh **Claude Code**, **Antigravity**, dan **OpenCode**.
   - Setiap memori yang disimpan dilabeli dengan agent asalnya (misal `[Agent: Claude Code]`, `[Agent: Antigravity]`, `[Agent: OpenCode]`).
   - **Lintas Sesi:** Sesi yang dibuka hari ini dapat membaca semua catatan dari sesi kemarin.
   - **Lintas Agent:** Pekerjaan yang dilakukan oleh Claude Code langsung terbaca saat Anda membuka project yang sama di Antigravity atau OpenCode.

3. **Lifecycle Hooks Terpadu:**
   - **Start / Check:** Saat sesi dibuka atau sebelum giliran prompt dimulai, sistem mengambil memori terbaru project tersebut (maks. 5 ringkasan sesi + 10 perubahan terbaru, ditambah fakta hasil ekstraksi server) dan menginjeksinya ke konteks prompt (`<supermemory-context>`). Memori dari agent lain langsung terbaca tanpa menunggu proses embedding selesai. Blok `<supermemory-context>` yang dikutip ulang oleh agent otomatis dibuang sebelum disimpan, jadi konteks tidak menumpuk berlapis.
   - **Change Observation:** Setiap kali ada modifikasi file atau eksekusi tool, perubahannya dicatat ke Supermemory.
   - **Stop / Session End:** Saat sesi berhenti atau idle, ringkasan sesi disimpan ke Supermemory untuk referensi di sesi berikutnya.

4. **Pembersihan Bersih & Bebas Konflik:**
   - Sepenuhnya menggantikan sistem memori lama seperti `claude-mem` dan `mem0`.
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
│   ├── supermemory-hook.ts  # Entrypoint hook CLI serbaguna untuk semua agent
│   └── sessions-ui.ts       # Entrypoint halaman daftar sesi Claude Code (bun run sessions)
├── data/                    # Log + database lokal
│   ├── stores/<model>-<dim>d/ # Satu database per model embedding (api-key, embedding-plan.json, models/ untuk model lokal, ...)
│   ├── current -> stores/…  # Symlink ke store aktif (dibuat start.sh)
│   ├── supermemory.log      # Log runtime server
│   ├── llm-proxy.log        # Log proxy LLM (status & durasi per request)
│   ├── zed-adapter.log      # Log adapter Zed
│   ├── sessions-trash/      # Sesi Claude yang dihapus lewat Sessions UI (bisa di-restore)
│   ├── opencode-trash/      # Backup (JSON) sesi OpenCode yang dihapus lewat Sessions UI (bisa di-restore)
│   ├── sessions-meta.json   # Nama & tag sesi (sidecar, transkrip tidak diubah)
│   └── sessions-ui.log      # Audit tiap aksi Sessions UI (disetujui/ditolak/kedaluwarsa)
├── scripts/
│   ├── start.sh             # Menjalankan 9router + llm-proxy + zed-adapter + supermemory-server (store sesuai model embedding)
│   ├── stop.sh              # Menghentikan supermemory-server + llm-proxy + zed-adapter (--all: juga 9router)
│   └── status.sh            # Cek status kesehatan, port, model, store aktif & daftar store
└── src/
    ├── hook-handler.ts      # Handler lifecycle (start, change, stop)
    ├── project-resolver.ts  # Deteksi root Git & hashing tag project
    ├── supermemory-client.ts# Client API HTTP lokal
    ├── installer.ts         # Pasang/copot hooks ke agent CLIs (Claude, Antigravity, OpenCode)
    ├── opencode-plugin.ts   # Plugin native OpenCode (template)
    ├── llm-proxy.ts         # Proxy supermemory → 9router (stream:false di chat, dimensions di embeddings)
    ├── zed-adapter.ts       # Adapter Zed edit prediction: /v1/completions → 9router /chat/completions
    ├── sessions-scan.ts     # Sessions UI: baca ~/.claude (read-only), sesi live, tautan memori
    ├── sessions-actions.ts  # Sessions UI: antrean persetujuan terminal, soft delete/restore/purge, nama & tag
    ├── sessions-other.ts    # Sessions UI: daftar sesi OpenCode & Antigravity (SQLite, dibuka read-only)
    ├── opencode-cli.ts      # Sessions UI: pembungkus `opencode session export|delete|import` + deteksi proses OpenCode
    ├── sessions-server.ts   # Sessions UI: server HTTP localhost + penjaga Host/Origin/token
    ├── sessions-page.ts     # Sessions UI: halaman HTML (tanpa resource eksternal)
    ├── hooks.test.ts        # Unit test (bun test)
    ├── sessions*.test.ts    # Unit test Sessions UI
    └── test-memory.ts       # Script verifikasi pembacaan & penulisan memori
```

---

## 🚀 Panduan Penggunaan Cepat

### 1. Konfigurasi (`.env`)

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
```

> **Catatan Model:** `ag/gemini-3.8-flash-low` (±50 detik per panggilan) dan `cc/claude-haiku-4-5-20251001` (±1–5 detik) sudah teruji bisa mengekstrak memori (tool calling & JSON) selama server berjalan lewat `llm-proxy` (otomatis dari `bun run start`). Tanpa proxy, 9router membalas dalam format streaming dan semua dokumen berakhir `failed` dengan error "Invalid JSON response". Untuk mengganti model, lihat [Mengganti Model](#mengganti-model).

---

### 2. Menjalankan Server

Butuh [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`). Pasang devDependencies sekali (`bun install`), lalu gunakan script bun atau bash langsung:

```bash
# Jalankan 9router (jika belum), llm-proxy, zed-adapter & Supermemory Server di background:
bun run start
# atau: ./scripts/start.sh (tambahkan --foreground untuk server di foreground)
```

Cek status layanan:

```bash
bun run status
# atau: ./scripts/status.sh
```

Untuk menghentikan:

```bash
bun run stop
# atau: ./scripts/stop.sh
# ./scripts/stop.sh --all  # sekalian menghentikan 9router
```

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

- **`PreInvocation`**: Mengeksekusi `supermemory-hook.ts antigravity start`. Mengembalikan objek JSON `{ "injectSteps": [{ "ephemeralMessage": "<supermemory-context>..." }] }` sehingga memori project otomatis disuntikkan sebelum model memproses instruksi.
- **`PostToolUse`** (matcher `write_to_file|replace_file_content|run_command`): Mencatat eksekusi tool ke Supermemory dan mengembalikan `{}`. Command read-only (`ls`, `cat`, `git status`, dll.) diabaikan agar memori tidak penuh noise.
- **`Stop`**: Menyimpan balasan terakhir asisten (`assistant_response` / `message`, maks. 4000 karakter; diterjemahkan ke bahasa Inggris lewat `TRANSLATE_MODEL` jika perlu) sebagai `session_summary`.
- Antigravity tidak punya hook compaction (hanya `PreInvocation`, `PostInvocation`, `PreToolUse`, `PostToolUse`, `SessionStart`), jadi ringkasan compaction-nya tidak bisa ditangkap. `Stop` tetap menyimpan balasan terakhir di setiap giliran.

#### Menyambungkan ke `agy` (Antigravity CLI)

Ringkasan hook yang dipasang installer di `~/.gemini/config/hooks.json` (satu entri bernama `supermemory-local`, `enabled: true`, timeout 15 detik per hook):

| Event agy       | Matcher                                            | Action               | Stdout                                                                                                           |
| --------------- | -------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `PreInvocation` | semua                                              | `antigravity start`  | `{"injectSteps":[{"ephemeralMessage":"<supermemory-context>…"}]}`, atau `{}` jika belum ada memori / server mati |
| `PostToolUse`   | `write_to_file\|replace_file_content\|run_command` | `antigravity change` | selalu `{}`                                                                                                      |
| `Stop`          | semua                                              | `antigravity stop`   | selalu `{}`                                                                                                      |

Perintah yang dijalankan tiap hook (path absolut, ditulis installer):

```bash
"<bun>" --env-file="<repo>/.env" "<repo>/bin/supermemory-hook.ts" antigravity <start|change|stop>
```

Catatan:

- `PreInvocation` jalan di **setiap giliran**, jadi konteks diambil ulang penuh tiap turn (tidak ada delta seperti `sync` di Claude Code/OpenCode). Tidak ada hook compaction di agy.
- Hook lain di file yang sama (mis. entri `zentty`) tidak diubah installer; installer hanya mengganti entri `supermemory-local`. File di-backup ke `hooks.json.bak-<waktu>` sebelum ditulis.
- Hook dibaca saat sesi agy dimulai: buka sesi baru setelah memasang. `bun run start` harus sudah berjalan, kalau tidak hook mengembalikan `{}`.
- Payload yang dibaca: `workspacePaths[0]` (folder project), `toolCall.{name,args}` (`TargetFile`, `CommandLine`, `Description`), dan `assistant_response` / `message` (balasan terakhir). Tool `view_*`, `read_*`, `search_web`, `schedule` dan command read-only diabaikan.

```bash
bun run install-hooks antigravity     # pasang / pasang ulang
bun run uninstall-hooks antigravity   # copot

# tes manual tanpa agy (tampilkan konteks yang akan disuntikkan, lalu cek log):
echo '{"workspacePaths":["'$PWD'"]}' | bun --env-file=.env bin/supermemory-hook.ts antigravity start
grep -i antigravity ~/.supermemory-hook.log | tail
```

Jika setelah sesi agy berjalan tidak ada baris `agent=antigravity` baru di log, hook belum dipanggil: cek `~/.gemini/config/hooks.json` (harus ada `supermemory-local`), path `bun` di perintah masih valid, dan sesi agy dibuka ulang.

### C. OpenCode (`~/.config/opencode/plugins/supermemory-local.ts`)

- Plugin di-generate dari `src/opencode-plugin.ts` dan otomatis ter-load dari folder plugins global (tidak perlu, dan jangan, didaftarkan di `opencode.json` karena akan ter-load dua kali).
- Menggunakan hook event lifecycle OpenCode:
  - `experimental.chat.system.transform`: Menginjeksi memori project ke dalam `system prompt` agent (`start` sekali per sesi, lalu `sync` di setiap turn untuk menambahkan memori baru dari agent/sesi lain).
  - `tool.execute.after`: Mencatat tool execution ke memori (tool read-only seperti `read`, `grep`, `glob` diabaikan).
  - `event (session.idle)`: Menyimpan ringkasan respons akhir asisten.
  - `event (session.compacted)`: Menyimpan pesan ringkasan compaction (assistant message ber-flag `summary`) lewat action `compact`.

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
   ./scripts/stop.sh
   ```
2. Hapus store aktif beserta marker sesi hook:
   ```bash
   rm -rf "./data/$(readlink ./data/current)" "${TMPDIR}supermemory-sync"
   ```
   Untuk mengosongkan semua model sekaligus: `rm -rf ./data/stores ./data/current "${TMPDIR}supermemory-sync"`.
3. Nyalakan kembali server:
   ```bash
   ./scripts/start.sh
   ```

### Mengganti Model

Semua model diatur di `.env`, dan setiap penggantian cukup diikuti `bun run stop && bun run start`. `start.sh` melewati layanan yang sudah berjalan, jadi tanpa `stop` proses lama tetap memakai `.env` versi lama.

#### Model embedding (`SUPERMEMORY_EMBEDDING_*`)

Server mengunci folder data ke provider, model, dimensi, dan endpoint yang pertama mengisinya (`embedding-plan.json`), lalu menolak start (`Embedding model mismatch`) kalau `.env` berbeda. Karena itu `start.sh` memakai satu store per model di `data/stores/<model>-<dim>d/`. Mengganti model tidak menghapus apa pun: model baru mendapat store kosong, dan kembali ke model lama membuka store lamanya lagi. Memori tidak dibagi antar model, karena embedding dari model berbeda tidak bisa dibandingkan.

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
3. Jalankan `bun run stop && bun run start`, lalu pastikan baris `Data:` dan `Embeddings:` menunjuk ke model baru. `bun run status` menampilkan store aktif dan daftar semua store.
4. Opsional:
   - Hapus store model yang tidak dipakai lagi: `rm -rf ./data/stores/<nama-store>`.
   - Bawa memori lama ke model baru: ekspor dari store lama (`POST /v3/documents/list` lalu `GET /v3/documents/:id`) sebelum langkah 2, lalu masukkan ulang dengan `POST /v3/documents` setelah langkah 3. Ekstraksi ulang memakai kuota 9router sebanding dengan jumlah dokumen.

> Endpoint embedding (`http://127.0.0.1:$LLM_PROXY_PORT`) ikut terkunci, jadi mengganti `LLM_PROXY_PORT` membuat store yang ada menolak start. Kembalikan port-nya, atau hapus store tersebut.

#### Terjemahan (`TRANSLATE_MODEL`)

Model embedding yang hanya berbahasa Inggris (mis. `Xenova/bge-base-en-v1.5`) butuh `TRANSLATE_MODEL`, yaitu model chat 9router yang menerjemahkan prompt (`sync`) dan ringkasan sesi (`stop`) ke bahasa Inggris. Teks yang sudah berbahasa Inggris dilewati tanpa panggilan LLM. Catatan perubahan tool dan ringkasan compaction tidak diterjemahkan, karena memori hasil ekstraksi server sudah berbahasa Inggris. Kalau terjemahan gagal atau lewat batas waktu (8 detik untuk prompt, 12 detik untuk ringkasan), teks asli yang dipakai. Prompt berbahasa Indonesia jadi lebih lambat sekitar 1–2 detik.

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
2. Ubah `OPENAI_MODEL` di `.env`, lalu jalankan `bun run stop && bun run start`. Store dan memori tidak berubah.
3. Cek `data/llm-proxy.log`: panggilan baru harus berstatus `200`, dan dokumen baru harus sampai ke status `done`.

#### Model edit prediction Zed, port, dan key

- **Model Zed:** ganti di pengaturan Zed. Adapter meneruskan `model` dari request apa adanya, jadi tidak perlu restart. `ZED_ADAPTER_REASONING_EFFORT` butuh `bun run stop && bun run start`.
- **`NINEROUTER_PORT`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`:** cukup `./scripts/stop.sh --all && bun run start`.

### Menghapus Dokumen Satu Container Tag

Untuk membuang dokumen uji (misalnya dari menjalankan hook manual dengan `cwd` sementara) tanpa mereset seluruh memori, hapus per dokumen lewat `DELETE /v3/documents/:id`:

```bash
bun --env-file=.env -e '
import { SupermemoryClient } from "./src/supermemory-client.ts";
import { resolveProject } from "./src/project-resolver.ts";
const c = new SupermemoryClient();
const tag = resolveProject("/tmp/sm-compact-test").containerTag; // atau tulis tag-nya langsung, mis. "proj_<nama>_<hash>_selftest"
for (const d of await c.listDocuments({ containerTags: [tag], limit: 100 }))
  console.log(d.id, (await c.request("DELETE", `/v3/documents/${d.id}`)).error ?? "deleted");'
```

> Dokumen yang masih diproses (ekstraksi memori lewat 9router, bisa beberapa menit) ditolak dengan `HTTP 409: Document is still processing`. Tunggu sampai selesai, lalu jalankan ulang.

### Log & Debugging

- Log server supermemory: `./data/supermemory.log`
- Log proxy LLM (status & durasi tiap request ke 9router): `./data/llm-proxy.log`
- Log adapter Zed (model, status & durasi tiap prediksi): `./data/zed-adapter.log`
- Log aktivitas hook: `~/.supermemory-hook.log` (di **home directory**, bukan di folder repo; dipakai bersama oleh semua agent dan semua project)
- Log gateway 9router: `~/.9router/logs/server.log`
- Log Sessions UI (audit tiap aksi: disetujui, ditolak, kedaluwarsa): `./data/sessions-ui.log`

#### Log hook (`~/.supermemory-hook.log`)

Satu baris per kejadian, format `[waktu ISO UTC] pesan`. Hook sengaja tidak pernah menulis diagnostik ke stdout (stdout dipakai untuk menyuntikkan konteks), jadi log ini satu-satunya tempat melihat apa yang terjadi:

```text
Invoked: agent=antigravity, action=start          # hook dipanggil agent
Project: supermemory-local (/path/ke/project), Agent: Antigravity
Injected 33 context lines for project …           # konteks disuntikkan
Saving session_summary (Antigravity): …           # catatan dikirim ke server
Save failed: HTTP …  /  Translate failed (…)      # kegagalan (hook tetap exit 0, agent tidak terblokir)
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

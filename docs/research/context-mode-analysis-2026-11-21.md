# Riset: mksglu/context-mode vs supermemory-local

Tanggal: 2026-11-21 · Status: eksplorasi, belum ada keputusan, belum ada perubahan kode.
Repo yang dianalisis: https://github.com/mksglu/context-mode (branch `main`, rilis `2.0.0-next.35`, ~34K bintang, lisensi ELv2).

## 1. Ringkasan

- Keduanya **bukan pesaing langsung**. context-mode menghemat *context window* (output tool besar) dan memulihkan state setelah compaction. supermemory-local menyimpan *ingatan lintas sesi dan lintas agent*.
- Titik temunya hanya satu: **memulihkan state setelah compaction atau di sesi baru**. Di situ context-mode punya teknik yang lebih rapi dan deterministik.
- Sisi "memori lintas sesi dan agent" mereka jual terpisah sebagai **Gateway** (hosted, berlangganan). Plugin gratisnya hanya satu project di satu mesin. Jadi supermemory-local setara versi self-hosted dari Gateway Memory/Recall, bukan padanan plugin.
- Separuh lainnya (sandbox `ctx_execute`, tolak Read besar, ganti output PostToolUse) tidak tumpang tindih sama sekali dan bisa dipasang berdampingan.

## 2. Sumber dan batasan

Dibaca: README, `docs/how-it-works.md`, `bench/e-continuity/README.md`, `hooks/hooks.json`, `src/core/hooks/dispatch.ts`, `src/core/compaction/{candidates,score,render,recall}.ts`, `src/core/journal/append.ts`, `src/core/index/auto-memory.ts`, `src/core/store/{schema,cleanup}.ts`, `src/core/tools/purge.ts`, `src/core/ops/db-heal.ts`, `src/core/project/resolve.ts`, prompt tool `ctx_search`/`ctx_resume`.

**Belum dibaca / tidak diverifikasi:**
- `search.ts` dan `fts.ts` secara rinci, hasil live eval kualitas compaction (`e2e/live/compact*`).
- Kode Gateway (hosted, tidak ada di repo).
- context-mode tidak dijalankan. Semua klaim performa adalah klaim penulis.
- Urutan hook `PostCompact` vs `SessionStart(source=compact)` di Claude Code, dan apakah hook `change` kita terpengaruh output yang diganti context-mode.

## 3. Dua arsitektur

```
context-mode                                  supermemory-local
------------                                  -----------------
Masalah: context window penuh output tool     Masalah: sesi baru lupa sesi lama,
         + amnesia setelah compaction                  agent lain lupa agent lain

PreToolUse  : tolak Read > 16 KB              SessionStart     : recall newest-first
PostToolUse : output > 4 KB -> di-index FTS5, UserPromptSubmit : hybrid search per prompt
              diganti 1-2 chunk terbaik       PostToolUse      : 1 dokumen / tool call
MCP ctx_*   : sandbox, search, resume         Stop / PostCompact: simpan ringkasan
        |                                              |
        v                                              v
  SQLite lokal per project                      supermemory-server
  (node:sqlite, WAL, FTS5 porter+trigram,       (embedding + ekstraksi LLM
   tanpa LLM, tanpa jaringan)                    via llm-proxy -> 9router)
```

| Aspek | context-mode (plugin) | supermemory-local |
|---|---|---|
| Tujuan | Hemat token, pulihkan state | Memori lintas sesi dan agent |
| Penyimpanan | `~/.context-mode/projects/<key>/context.db`, satu per project | Satu store per model embedding (`data/stores/<model>-<dims>d`) |
| Pencarian | BM25 (FTS5 porter + trigram) digabung RRF, koreksi typo, tanpa embedding | Hybrid: vektor + chunk dokumen, per tag |
| Ketergantungan LLM | Tidak ada | Ekstraksi, terjemahan, embedding (opsional remote) |
| Skema event | `prompt/edit/cmd/toolerr/index/cost/decision` + `key/path/ok/turn` | `session_summary`, `change_observation` (teks bebas + metadata) |
| Anggaran konteks | Blok 2 KB, dipilih per skor/byte, baris tidak pernah dipotong | Hitungan tetap per tipe (5x800, 10x300 karakter), teks dipotong |
| Agent | 11 | 3 (Claude Code, Antigravity, OpenCode) |
| Lintas mesin | Tidak (DB lokal per mesin) | Ya, kalau server di-host |
| Lisensi | ELv2 | Milik sendiri |

Fakta lokal terukur (2026-11-21): `data/` = 593 MB, store aktif 545 MB, `supermemory.log` 23 MB.

## 4. Gagasan yang bisa dipinjam

Setiap gagasan ditandai: **Klien** (hanya logika di sisi hook/klien, store tetap supermemory-server) atau **Lokal** (perlu store lokal tambahan).

| # | Gagasan | Asal di context-mode | Kita sekarang | Jenis | Masalah yang disentuh |
|---|---|---|---|---|---|
| G1 | **Blok `start` beranggaran byte.** Skor = bobot x peluruhan umur x bonus ulangan; pilih greedy per rasio skor/byte; baris yang tidak muat jadi penunjuk, tidak dipotong | `compaction/render.ts`, `score.ts` | `RECALL` hitungan tetap, potong karakter (`hook-handler.ts:26`) | Klien | Lupa setelah compaction |
| G2 | **Dedup changed files.** Satu baris per path ("edited X x3"), last write wins | `compaction/candidates.ts` | Satu dokumen per tool call (`hook-handler.ts:409`) | Klien (pada render) atau Klien (pada tulis) | Catatan berisik |
| G3 | **Open errors.** Kegagalan terakhir per key, terbuka sampai ada sukses sesudahnya | `candidates.ts` | Tidak ada; `parseChange` bahkan tidak membawa `tool_response` atau status | Klien, perlu `ok`/`key` di metadata | Lupa setelah compaction |
| G4 | **Decision rows** dari jawaban `AskUserQuestion` | `hooks/decision.ts` | Tidak ada | Klien | Lupa setelah compaction |
| G5 | **Push recall sesudah compaction.** BM25 prompt vs baris, MMR agar tidak redundan, baris utuh, sekali per sesi | `compaction/recall.ts`, `dispatch.ts:267` | Hybrid search per prompt sudah ada; belum diverifikasi apakah `SessionStart(compact)` menyuntik ulang | Klien | Lupa setelah compaction |
| G6 | **Penulisan detached + spool.** Hook tidak menunggu; kalau DB sibuk, tulis ke antrean | `hooks/spool.ts`, `detached.ts` | Hook memanggil HTTP ke server; satu dokumen per tool call memicu pipeline ekstraksi | Lokal (atau antrean file di sisi klien) | Ekstraksi lambat/gagal |
| G7 | **Pipeline deterministik tanpa LLM** untuk event mentah; LLM hanya untuk ringkasan | seluruh `core/journal` | Setiap dokumen melewati ekstraksi LLM; proposal v2 mencatat ~2/3 dari 9.343 dokumen `failed` | Lokal | Ekstraksi gagal |
| G8 | **Retensi dan batas ukuran.** Hapus sumber tidak diakses >30 hari; batas 500 MB per project, hapus yang paling lama diakses; sapu project mati 14 hari; `ctx_purge` per session/source/project | `store/cleanup.ts`, `tools/purge.ts`, `constants.ts` | Hanya hapus manual `DELETE /v3/documents/:id` (409 saat processing); tidak ada retensi | Klien (skrip retensi lewat API) | Database penuh |
| G9 | **Self-heal DB.** `integrity_check`, lalu heal lossless atau pindahkan `.bak` dan buat ulang | `ops/db-heal.ts`, `doctor` | `bun run status`, `supermemory-server doctor` | Klien | Database penuh |
| G10 | **Migrasi skema berversi** (`user_version`, langkah per versi, satu transaksi) dan deteksi/hapus instalasi v1 | `store/schema.ts`, `ops/detect-v1.ts`, `v1-remove.ts` | Installer mencadangkan `.bak-<ts>`, tidak ada versi skema | Klien | Migrasi tools |
| G11 | **Scope `session | worktree | project`** pada pencarian | `ctx_search` | Satu `readTags` per project | Klien | Catatan berisik |
| G12 | **Fixture per versi host + golden test** untuk payload hook | `e2e/fixtures/<agent>/<versi>/`, `e2e/golden` | `src/agents/fixtures` sudah ada (v2) | Klien | Migrasi tools |
| G13 | **Statistik dan pengukuran** (`ctx_stats`, baris `cost`, bench ber-preregistrasi) | `tools/stats.ts`, `bench/` | `bun run status` hanya kesehatan, tidak mengukur manfaat recall | Klien | Semua |
| G14 | **Memori file instruksi ikut dicari** (CLAUDE.md, AGENTS.md, GEMINI.md, ...) | `index/auto-memory.ts` | Tidak | Klien | Migrasi tools |

Catatan G2: efek jelasnya baru terlihat bila `change` membawa `path` dan jumlah edit sebagai metadata, bukan hanya teks `File: <path>`.

## 5. Tiga masalah tambahan dari pengguna

### 5.1 Migrasi tools
- context-mode memisahkan **adapter per host** (`adapters/table.ts`: cara pasang, sumber project, prefix nama tool, cara kirim blok compaction, kanal deny) dan menguji dengan fixture per versi host. Kita sudah menuju arah yang sama (`src/agents/<agent>.ts` + fixture), jadi G12 mostly sudah tercapai.
- Yang belum ada di kita: deteksi dan pembersihan instalasi lama (G10), serta pembacaan file instruksi antar-agent (G14).
- Memori kita memakai label `[Agent: ...]` dan tag per project, jadi pindah agent tidak kehilangan memori. Risiko migrasi ada di sisi hook (payload berubah), bukan di data.

### 5.2 Database penuh
- Saat ini tidak ada retensi. Store aktif 545 MB dan terus tumbuh; satu dokumen per tool call mempercepatnya.
- Pelajaran context-mode: retensi berbasis usia akses plus batas ukuran per project, dijalankan satu kali saat start (bukan timer), dan hanya bila tidak ada pemilik hidup (G8).
- Keterbatasan kita: server tidak bisa re-tag dokumen dan `DELETE` memberi 409 selama dokumen masih processing. Retensi harus lewat API, mengabaikan dokumen processing, dan mencoba lagi nanti.
- Dengan G2 (tidak menyimpan satu dokumen per tool call) pertumbuhan turun di sumbernya.

### 5.3 Ganti model embedding
- Kita terkunci **satu store per model** (`embedding-plan.json`); ganti model berarti store baru yang kosong, memori lama tetap di store lama tapi tidak terbaca.
- context-mode tidak punya embedding sama sekali (FTS5 BM25), jadi tidak ada kunci model. Harganya: tidak ada pencarian semantik dan lemah untuk bahasa Indonesia (porter hanya men-stem Inggris ASCII; token lain lewat apa adanya).
- Konsekuensi: **journal lokal berbasis FTS5 tidak terpengaruh ganti model embedding**. Event mentah (G3, G4, G5, G7) di store terpisah akan bertahan lintas penggantian model; hanya lapisan semantik di server yang harus dibangun ulang.
- Untuk migrasi model dengan memori terjaga: ekspor dokumen dari store lama (teks asli ada di dokumen) lalu impor ulang ke store model baru. Ini belum diverifikasi dan bukan fitur context-mode.

## 6. Skenario A: pasang berdampingan

context-mode dipasang apa adanya (`claude plugin install context-mode@context-mode`, Node >= 24.15), supermemory-local tidak diubah.

```
Claude Code
 |- hook SessionStart/UserPromptSubmit --> supermemory (blok memori lintas sesi)
 |                                    \-> context-mode (blok resume/recall lokal)   <- potensi dobel
 |- hook PreToolUse  --> context-mode (tolak Read besar)
 |- hook PostToolUse --> context-mode (ganti output besar)  \
 |                   \-> supermemory change (catat tool call)  <- membaca input, bukan output
 '- MCP: ctx_* (9 tool) + supermemory_* (search/add/profile)
```

**Untung**
- Menyelesaikan "boros token" tanpa menyentuh kode kita. Penulis mengklaim median 99,4% byte hemat pada 36 baris output >= 10 KB (bench sendiri, bukan ukuran kualitas jawaban).
- Journal lokal context-mode tidak bergantung 9router, jadi pemulihan setelah compaction tetap jalan saat ekstraksi kita rusak.
- Tidak ada kode yang disalin, jadi isu lisensi minimal.

**Rugi / risiko**
- Biaya tetap ~2.000 token per sesi pada tugas kecil (diakui penulis, `docs/how-it-works.md`).
- **Injeksi dobel**: dua blok state/recall di `SessionStart` dan `UserPromptSubmit`. Perlu diukur, bisa menambah token bukan menghemat.
- Dua sumber kebenaran untuk "apa yang terjadi di sesi ini" dengan format berbeda; agent bisa bingung memakai `ctx_search` atau `supermemory_search`.
- Hook `change` kita hanya memakai `tool_input` (`parseChange`), jadi penggantian output oleh context-mode tidak memengaruhinya. Konflik langsung tampaknya kecil, tapi belum diuji.
- Hanya melayani agent yang didukung kedua pihak. Antigravity tidak ada di daftar 11 agent context-mode; OpenCode ada.
- Versi masih `next`, berubah cepat.
- Data context-mode per mesin; di VPS tidak terbagi ke mesin lain.

**Yang perlu diuji sebelum memutuskan:** ukur token blok SessionStart/UserPromptSubmit dengan dan tanpa kedua plugin pada satu sesi yang sama; cek urutan eksekusi hook; cek apakah `ctx_*` memperburuk `supermemory_*` dalam pemilihan tool.

## 7. Skenario B: ganti sebagian

Jalur journal lokal (event bertipe, FTS5, tanpa LLM) menggantikan sebagian peran server untuk **event mentah**, sementara server tetap untuk fakta semantik dan ringkasan.

```
hook PostToolUse --> journal lokal (bun:sqlite + FTS5)   <- event mentah, deterministik, detached
hook Stop/Compact --> supermemory-server                 <- ringkasan, fakta, lintas agent
hook Start/Prompt <-- render blok (G1) dari KEDUA sumber
```

**Untung**
- Menyentuh langsung dua masalah utama: ekstraksi gagal/lambat (event mentah tidak lewat LLM) dan catatan berisik (G2, G3).
- Kebal terhadap pergantian model embedding untuk lapisan event (5.3).
- Hook `change` tidak lagi memanggil HTTP per tool call.
- `bun:sqlite` bawaan Bun mendukung FTS5, jadi dependensi runtime tetap nol (perlu dicek untuk build Bun yang dipakai).

**Rugi / risiko**
- Melanggar prinsip saat ini "supermemory-server satu-satunya store" dan perlu mengubah CLAUDE.md, spec OpenSpec, `status`, dan Sessions UI.
- Dua store berarti dua tempat retensi, backup, dan migrasi skema.
- **Lintas mesin/VPS**: SQLite lokal tidak ikut ke VPS. Bila server dipindah ke VPS pribadi, journal lokal hanya melihat mesin itu. Event mentah harus tetap dikirim ke server kalau ingin dibagi antar mesin, sehingga keuntungan "tanpa jaringan" hilang untuk bagian itu.
- FTS5 porter lemah untuk Indonesia; pada event mentah (path, perintah, pesan error berbahasa Inggris) dampaknya kecil, pada prompt Indonesia lebih besar.
- Biaya rancang: skema, retensi, pemilihan per anggaran, pengujian. context-mode sendiri butuh puluhan modul untuk ini.

**Varian ringan (tanpa store kedua):** terapkan hanya sisi klien. Kirim `ok`, `key`, `path` sebagai metadata dokumen; dedup per path saat render (G2); hitung open errors dari metadata (G3); render blok dengan anggaran (G1). Server tetap satu-satunya store. Ini menyentuh "lupa setelah compaction" dan "berisik", tapi **tidak** menyelesaikan "ekstraksi gagal/lambat" karena setiap tool call tetap menjadi dokumen.

## 8. Perbandingan skenario

| Kriteria | A. Berdampingan | B. Ganti sebagian | B-ringan (klien saja) |
|---|---|---|---|
| Boros token | Selesai | Tidak (kecuali digabung A) | Tidak |
| Ekstraksi gagal/lambat | Tidak tersentuh | Teratasi untuk event mentah | Tidak tersentuh |
| Lupa setelah compaction | Sebagian (blok mereka) | Ya (G1, G3, G5) | Ya |
| Catatan berisik | Tidak tersentuh | Ya (G2) | Ya |
| Database penuh | Tidak tersentuh | Retensi lokal + server | Retensi lewat API |
| Ganti model embedding | Tidak tersentuh | Lapisan event kebal | Tidak tersentuh |
| Kompatibel dengan VPS | Lokal per mesin | Terbagi dua | Ya |
| Dependensi baru | Node 24 + plugin | Tidak (bun:sqlite) | Tidak |
| Melanggar prinsip arsitektur | Tidak | Ya | Tidak |
| Usaha | Kecil (uji) | Besar | Sedang |

Kombinasi A + B-ringan tidak saling bertentangan: A untuk token, B-ringan untuk kualitas memori.

## 9. Lisensi (ELv2)

- Konteks pengguna: dipakai pribadi, nanti di VPS pribadi.
- ELv2 melarang menawarkan perangkat lunak ke pihak lain sebagai layanan hosted/managed, menghindari fungsi license key, dan menghapus pemberitahuan lisensi. Pemakaian sendiri, termasuk di VPS sendiri, tampaknya tidak dilarang. Ini bacaan saya atas teks README, bukan nasihat hukum.
- Kalau nanti ada pengguna lain di VPS yang sama, tinjau ulang. Fork `irfnd` dengan `feat/dokploy` berpotensi menyentuh batas itu.
- Gagasan dan algoritma tidak dilindungi lisensi; hanya kode. Menulis ulang dari gagasan menghindari persoalan.

## 10. Pertanyaan terbuka

1. Seberapa besar overlap injeksi sebenarnya jika kedua plugin aktif? (ukur, jangan tebak)
2. Apakah `SessionStart(source=compact)` kita menyuntik ulang blok dan apakah `PostCompact` selesai sebelum itu?
3. Apakah bun:sqlite di build Bun yang dipakai punya FTS5 dan trigram?
4. Berapa persen dokumen saat ini `failed` setelah model ekstraksi diperbaiki (proposal v2 mencatat ~2/3 sebelum perbaikan)? Ini menentukan apakah G7 masih mendesak.
5. Apakah server bisa mengekspor dan mengimpor dokumen untuk berpindah model embedding tanpa kehilangan memori?
6. Batasan arsitektur: masih "belum tahu" (store tunggal vs journal lokal). Keputusan ini menentukan skenario B.
7. Rencana VPS: server saja di VPS, atau hook juga? Menentukan apakah journal lokal masuk akal.

## 11. Langkah berikutnya yang mungkin (belum dipilih)

- Ukur dobel injeksi dengan memasang context-mode pada satu project uji (Skenario A).
- Verifikasi pertanyaan 2 dan 3 dengan membaca kode dan menjalankan skrip kecil.
- Bila memilih B-ringan: buat perubahan OpenSpec (mis. `memory-recall-budget`) yang mencakup G1-G3 saja.
- Baca `search.ts`/`fts.ts` dan hasil `e2e/live/compact-hard` bila ingin menilai kualitas, bukan hanya penghematan byte.

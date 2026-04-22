<div align="center">

# ⚡ Cassalux Backend
### *Quiz Helper AI — High Performance Node.js API Server*

[![Node.js](https://img.shields.io/badge/Node.js-20.x-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![Express](https://img.shields.io/badge/Express-4.x-000000?style=for-the-badge&logo=express&logoColor=white)](https://expressjs.com)
[![Groq](https://img.shields.io/badge/Groq-AI-F55036?style=for-the-badge&logo=groq&logoColor=white)](https://groq.com)
[![PM2](https://img.shields.io/badge/PM2-Process_Manager-2B037A?style=for-the-badge&logo=pm2&logoColor=white)](https://pm2.keymetrics.io)
[![Nginx](https://img.shields.io/badge/Nginx-Reverse_Proxy-009639?style=for-the-badge&logo=nginx&logoColor=white)](https://nginx.org)
[![Discord](https://img.shields.io/badge/Discord-AI_Agent-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.com)

```
╔═══════════════════════════════════════════════╗
║   50 concurrent users • ~1.2s response time  ║
║   7 Groq API keys • Smart load balancing      ║
║   AI Security Agent • Discord monitoring      ║
╚═══════════════════════════════════════════════╝
```

> Backend API server untuk Quiz Helper AI (Cassalux) — melayani permintaan jawaban soal secara real-time menggunakan Groq AI dengan smart load balancing, caching, dan monitoring via Discord.

---

### 🔗 Repo Terkait
**[📦 cassalux-backend](https://github.com/itscasaa/cassalux-backend)** ← kamu di sini &nbsp;|&nbsp; **[🖥️ cassalux-panel](https://github.com/itscasaa/cassalux-panel)** ← admin panel

</div>

---

## 📋 Daftar Isi

- [✨ Fitur](#-fitur)
- [🏗️ Arsitektur](#️-arsitektur)
- [⚙️ Instalasi](#️-instalasi)
- [🔧 Konfigurasi](#-konfigurasi)
- [🚀 Menjalankan Server](#-menjalankan-server)
- [📡 API Endpoints](#-api-endpoints)
- [🛡️ Admin Panel API](#️-admin-panel-api)
- [🤖 Discord AI Agent](#-discord-ai-agent)
- [🧪 Testing](#-testing)
- [📊 Monitoring](#-monitoring)

---

## ✨ Fitur

### 🧠 AI Engine
- **Smart Load Balancing** — rotasi otomatis antar 7 Groq API keys
- **Fallback System** — primary keys → backup keys otomatis
- **Rate Limit Detection** — auto-skip key yang kena rate limit
- **Multi-soal Support** — jawab banyak soal sekaligus dalam 1 request

### ⚡ Performance
- **Response Time ~1.2-1.5 detik** via HTTPS dari luar server
- **50+ concurrent users** tanpa bottleneck
- **Smart Caching** — soal yang sama langsung dari cache
- **Cache per Angkatan** — isolasi data antar angkatan

### 🔐 Security
- **API Key Authentication** — setiap user punya key unik
- **IP Locking** — key terkunci ke IP pertama yang menggunakan
- **Admin Key Protection** — semua endpoint admin dilindungi
- **Nginx Rate Limiting** — proteksi dari brute force

### 🤖 Discord AI Agent
- **Auto Monitoring** setiap 5 menit
- **Security Alert** — deteksi IP mencurigakan & brute force
- **IP Intelligence** — info lengkap IP (lokasi, ISP, proxy/VPN)
- **One-click Ban** — ban IP langsung dari Discord
- **Watchlist** — pantau IP mencurigakan
- **Interactive Commands** — `!status`, `!scan`, `!banned`, `!unban`, `!analyze`

### 📊 Real-time Console
- **SSE (Server-Sent Events)** — log realtime di admin panel
- **Notification System** — push notif ke panel saat ada event penting

---

## 🏗️ Arsitektur

```
                    ┌─────────────────┐
                    │   Extension     │
                    │  (Chrome/FF)    │
                    └────────┬────────┘
                             │ HTTPS
                    ┌────────▼────────┐
                    │     Nginx       │
                    │  (Reverse Proxy)│
                    │  SSL/TLS        │
                    └────────┬────────┘
                             │
              ┌──────────────▼──────────────┐
              │      quiz-backend           │
              │      (Node.js + Express)    │
              │                             │
              │  ┌─────────────────────┐    │
              │  │   Smart LB          │    │
              │  │  Primary Keys x7    │    │
              │  │  Backup Keys x?     │    │
              │  └──────────┬──────────┘    │
              │             │               │
              │  ┌──────────▼──────────┐    │
              │  │    Groq API         │    │
              │  │  llama-3.1-8b       │    │
              │  └─────────────────────┘    │
              │                             │
              │  ┌─────────────────────┐    │
              │  │   Cache System      │    │
              │  │  (per angkatan)     │    │
              │  └─────────────────────┘    │
              └──────────────┬──────────────┘
                             │
              ┌──────────────▼──────────────┐
              │    cassalux-agent           │
              │    (Discord Bot)            │
              │    Security + Monitor       │
              └─────────────────────────────┘
```

---

## ⚙️ Instalasi

### Prerequisites
- Ubuntu 22.04 LTS
- Node.js 20.x
- PM2
- Nginx
- Domain + DuckDNS
- SSL Certificate (Let's Encrypt)

### 1. Clone Repository

```bash
git clone https://github.com/itscasaa/cassalux-backend.git
cd cassalux-backend
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Setup File Konfigurasi

```bash
# Buat file .env
cp .env.example .env
nano .env
```

### 4. Buat File Keys

```bash
# keys.json — API keys untuk user
cat > keys.json << 'EOF'
{
  "keys": []
}
EOF

# groq_keys.json — Groq API keys
cat > groq_keys.json << 'EOF'
{
  "keys": []
}
EOF
```

### 5. Setup Nginx

```bash
sudo tee /etc/nginx/sites-available/cassalux << 'EOF'
server {
    listen 80;
    server_name cassalux.duckdns.org;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name cassalux.duckdns.org;

    ssl_certificate /etc/letsencrypt/live/cassalux.duckdns.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/cassalux.duckdns.org/privkey.pem;

    location /api/ {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location /admin/ {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /health {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
    }
}
EOF

sudo ln -s /etc/nginx/sites-available/cassalux /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 6. SSL Certificate

```bash
sudo certbot certonly --nginx -d cassalux.duckdns.org
```

---

## 🔧 Konfigurasi

Buat file `.env` dengan isi berikut:

```env
# Admin Key — untuk akses panel admin
ADMIN_KEY=your-secret-admin-key

# Groq API Keys
GROQ_KEY_1=gsk_xxxxxxxxxxxx
GROQ_KEY_2=gsk_xxxxxxxxxxxx
# tambahkan lebih banyak sesuai kebutuhan

# Discord Bot
DISCORD_TOKEN=your-discord-bot-token
DISCORD_CHANNEL_ID=your-channel-id

# Groq Agent Key (khusus untuk AI agent)
GROQ_AGENT_KEY=gsk_xxxxxxxxxxxx
```

> ⚠️ **JANGAN** commit file `.env` ke GitHub! Sudah ada di `.gitignore`.

---

## 🚀 Menjalankan Server

```bash
# Start dengan PM2
pm2 start server.js --name quiz-backend
pm2 start agent.js --name cassalux-agent

# Auto-start saat reboot
pm2 save
pm2 startup

# Cek status
pm2 list

# Lihat logs
pm2 logs quiz-backend
pm2 logs cassalux-agent
```

---

## 📡 API Endpoints

### `POST /api/answer`
Endpoint utama untuk menjawab soal.

**Request:**
```json
{
  "question": "1. Ibukota Indonesia?\na. Bandung\nb. Jakarta\nc. Surabaya\nd. Medan",
  "apikey": "YOUR-API-KEY"
}
```

**Response:**
```json
{
  "answer": "1. b. Jakarta",
  "reason": "",
  "provider": "groq_primary",
  "cached": false,
  "angkatan": "25"
}
```

### `GET /health`
Cek status server.

```json
{
  "status": "ok",
  "totalReq": 1500,
  "totalKeys": 25,
  "totalGroqKeys": 7,
  "activeUsers": 3
}
```

---

## 🛡️ Admin Panel API

Semua endpoint admin memerlukan `?adminkey=YOUR_ADMIN_KEY`

| Method | Endpoint | Deskripsi |
|--------|----------|-----------|
| `GET` | `/admin/keys` | List semua API keys |
| `POST` | `/admin/keys` | Tambah API key baru |
| `DELETE` | `/admin/keys` | Hapus API key |
| `POST` | `/admin/keys/reset-ip` | Reset IP lock |
| `GET` | `/admin/groq-keys` | List Groq keys |
| `POST` | `/admin/groq-keys` | Tambah Groq key |
| `DELETE` | `/admin/groq-keys` | Hapus Groq key |
| `POST` | `/admin/groq-keys/toggle` | Enable/disable Groq key |
| `GET` | `/admin/system` | Info CPU/RAM/Disk/Network |
| `GET` | `/admin/active-users` | User aktif 5 menit terakhir |
| `GET` | `/admin/cache` | Info cache sessions |
| `POST` | `/admin/cache/clear` | Hapus cache |
| `GET` | `/admin/providers` | Status AI providers |
| `POST` | `/admin/providers/reset` | Reset provider |
| `GET` | `/admin/notifications` | List notifikasi |
| `POST` | `/admin/notifications/clear` | Hapus notifikasi |
| `GET` | `/admin/console` | SSE realtime logs |

> 🖥️ Kelola semua endpoint di atas dengan mudah melalui **[Cassalux Panel](https://github.com/itscasaa/cassalux-panel)**

---

## 🤖 Discord AI Agent

Agent berjalan otomatis setiap 5 menit dan melaporkan kondisi server ke Discord.

### Commands

| Command | Deskripsi |
|---------|-----------|
| `!status` | Cek status server real-time |
| `!scan` | Security scan manual |
| `!banned` | Lihat daftar IP yang dibanned |
| `!unban <ip>` | Unban IP tertentu |
| `!watchlist` | Lihat IP yang dipantau |
| `!analyze` | Trigger analisa AI manual |
| `!help` | Tampilkan bantuan |

### Security Features
- 🔴 **High** — 10+ percobaan invalid key dari 1 IP
- 🟠 **Medium** — 5-9 percobaan
- 🟡 **Low** — 3-4 percobaan
- Deteksi **IP Mismatch** (key dipakai dari IP berbeda)
- Info **Proxy/VPN** detection
- **One-click ban** via iptables

---

## 🧪 Testing

### Test Single Request
```bash
curl -s -X POST https://cassalux.duckdns.org/api/answer \
  -H "Content-Type: application/json" \
  -d '{"question":"Ibukota Indonesia?\na. Bandung\nb. Jakarta","apikey":"YOUR-KEY"}' \
  -w "\nWaktu: %{time_total}s\n"
```

### Test 10 Concurrent Users
```bash
for i in {1..10}; do
  curl -s -X POST https://cassalux.duckdns.org/api/answer \
    -H "Content-Type: application/json" \
    -d '{"question":"Ibukota Indonesia?\na. Bandung\nb. Jakarta","apikey":"YOUR-KEY"}' &
done
wait && echo "DONE"
```

### Hasil Testing (50 concurrent users)
```
User 1  | 1238ms | groq_primary | ✅
User 2  | 1350ms | groq_primary | ✅
...
User 50 | 1473ms | groq_primary | ✅
══════════════════════════════════
SELESAI: 1 detik total — 50/50 berhasil
```

---

## 📊 Monitoring

```bash
# Real-time monitoring
pm2 monit

# Logs
pm2 logs quiz-backend --lines 50

# Restart
pm2 restart quiz-backend

# Status
pm2 list
```

---

<div align="center">

## 🔗 Hubungkan dengan Admin Panel

Untuk mengelola server ini secara visual, gunakan **Cassalux Panel**

[![Cassalux Panel](https://img.shields.io/badge/Cassalux_Panel-Setup_Guide-6c63ff?style=for-the-badge&logo=laravel&logoColor=white)](https://github.com/itscasaa/cassalux-panel)

---

Made with ❤️ by **itscasaa**

</div>

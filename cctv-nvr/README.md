# 🛡️ Homelab CCTV NVR (100% Free & Open-Source, Zero Subscription)

A self-hosted, local Network Video Recorder (NVR) powered by **[Frigate](https://frigate.video/)** and **[go2rtc](https://github.com/AlexxIT/go2rtc)**.

* **Zero Subscriptions**: No monthly cloud fees, no paywalled features.
* **100% Local**: All recordings and AI detections remain on your local storage (`./storage/`).
* **AI Object Detection**: Detects persons, cars, and animals locally on CPU (or GPU/Coral).
* **Sub-Second Live Streaming**: Powered by built-in WebRTC (`go2rtc`).

---

## Quick Start

### 1. Set Your Camera Verification Code
Open [`.env`](file:///E:/GitHub/mikrotik/cctv-nvr/.env) and set your 6-letter verification code (printed on the camera body sticker):
```bash
CCTV_VERIFICATION_CODE=YOUR_CODE_HERE
```

### 2. Disable EZVIZ Image Encryption (Crucial!)
In the **EZVIZ mobile app**:
* Go to Camera Settings (gear icon) ➔ **Image Encryption** ➔ Turn **OFF**.
*(If left on, third-party NVRs will see a black scrambled screen).*

### 3. Start the NVR
In terminal / PowerShell, navigate to this folder and run:
```bash
docker compose up -d
```

### 4. Access the Web Dashboard
* **On your PC**: Open [http://localhost:5000](http://localhost:5000)
* **On your Android Phone** (connected to Wi-Fi): Open `http://192.168.88.254:5000`

---

## Directory Structure
```text
cctv-nvr/
├── docker-compose.yml     # Frigate & go2rtc container definition
├── .env                   # Camera credentials (gitignored)
├── .env.example           # Configuration template
├── config/
│   └── config.yml         # Frigate camera streams, AI detection, and recording rules
└── storage/               # Saved recordings, clips, and snapshots
```

---

## Useful Commands
* **View Live Container Logs**:
  ```bash
  docker compose logs -f frigate
  ```
* **Restart the NVR**:
  ```bash
  docker compose restart
  ```
* **Stop the NVR**:
  ```bash
  docker compose down
  ```

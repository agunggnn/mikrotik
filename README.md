# 🌐 MikroTik Homelab, Hotspot Voucher Billing & CCTV Sentinel

Autonomous homelab network hub and services powered by **MikroTik RouterOS (RB951Ui-2HnD)** and managed via **Jagdpanzer (`jagd`)**.

---

## 📑 Architecture Overview

| Component | Service / IP | Role | Status |
| :--- | :--- | :--- | :--- |
| **MikroTik Router** | `192.168.88.1` | RouterOS Network Hub & Hotspot Gateway | Active |
| **IndiHome Uplink** | `ether1` (DHCP) | WAN Uplink with Masquerade NAT & Firewall | Active |
| **DevOps Workstation** | `ether2` (`192.168.88.10`) | Static DHCP Lease & WoL Target (`70:85:C2:2A:48:B1`) | Configured |
| **EZVIZ H3c CCTV** | `ether5` / Wi-Fi | 2K QHD (2560x1440) HEVC Surveillance Stream | RTSP Active |
| **Mikhmon** | `localhost:9090` | Hotspot Voucher Generator & User Accounting | **Connected** |
| **Frigate NVR** | `localhost:5000` | 24/7 Local DVR & AI Object Detection Sentinel | On-Demand |

---

## 📶 1. Hotspot & Voucher Billing (`mikhmon`)

### Web UI
- **URL**: [http://localhost:9090](http://localhost:9090)
- **Default Login**: `mikhmon` / `1234`
- **Router Session**:
  - IP: `192.168.88.1`
  - User: `mikhmon`
  - Password: `mikhmonpass`
  - API Port: `8728`
  - Hotspot: `hs-homelab`
  - DNS: `wifi.net`

### Voucher Profiles
1. **1 Jam**: 2 Mbps DL / 1 Mbps UL (Rp 2.000) - Profile `1Jam-2M`
2. **3 Jam**: 3 Mbps DL / 1 Mbps UL (Rp 3.000) - Profile `3Jam-3M` *(Populer)*
3. **12 Jam**: 5 Mbps DL / 2 Mbps UL (Rp 5.000) - Profile `12Jam-5M`
4. **24 Jam**: 10 Mbps DL / 3 Mbps UL (Rp 10.000) - Profile `24Jam-10M`

### Captive Portal Template
Custom responsive dark-mode landing page located at `hotspot-template/`:
- `login.html`: Mobile-optimized voucher login & price list
- `status.html`: Real-time session time left, speed, and data counter
- `logout.html`: Clean session termination confirmation

---

## 📹 2. Local CCTV NVR (`cctv-nvr`)

- **Resolution**: 2560x1440 (2K QHD) @ 25fps HEVC
- **Storage**: Continuous local recordings saved to `cctv-nvr/storage/`
- **Stream Restreamer**: `go2rtc` at `localhost:1984`
- **Frigate Dashboard**: `localhost:5000`
- **Standby Mode**: To save electricity on the PC, Frigate can be started/stopped on demand while waiting for the on-camera MicroSD card.

---

## 🎮 3. Tactical Management CLI (`jagd`)

Managed seamlessly using the user's native orchestrator:

```powershell
# Mikhmon Voucher Management
jagd up mikhmon         # Start Mikhmon container on port 9090
jagd stop mikhmon       # Stop Mikhmon
jagd logs mikhmon       # View live Mikhmon logs

# Frigate CCTV Sentinel
jagd up frigate         # Start Frigate 24/7 NVR on port 5000
jagd stop frigate       # Halt NVR to save PC electricity
jagd logs frigate       # Inspect camera streams
```

---

## 🔮 4. Roadmap & Next Steps
- [ ] **Payment Gateway Integration**: Connect Tripay or Midtrans API keys for automatic QRIS / DANA self-checkout vouchers.
- [ ] **Cloudflare Zero Trust Tunnel**: Expose Mikhmon securely over `https://mikhmon.yourdomain.com` for 100% free remote management from your phone anywhere.
- [ ] **On-Camera MicroSD**: Insert MicroSD card into H3c for zero-electricity 24/7 recording directly inside the EZVIZ mobile app.

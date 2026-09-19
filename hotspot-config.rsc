# ==============================================================================
# MIKROTIK HOTSPOT & VOUCHER BILLING SETUP SCRIPT
# RouterOS v6.x / v7.x Consolidated Setup for Hotspot + Mikhmon
# ==============================================================================

# ------------------------------------------------------------------------------
# 1. ENABLE ROUTEROS API FOR MIKHMON
# ------------------------------------------------------------------------------
/ip service set api disabled=no port=8728

# Create dedicated restricted admin user for Mikhmon API
/user group add name=mikhmon-group policy=read,write,api,test
/user add name=mikhmon group=mikhmon-group password=mikhmonpass comment="Mikhmon API User"

# ------------------------------------------------------------------------------
# 2. HOTSPOT IP POOL & SERVER PROFILE
# ------------------------------------------------------------------------------
/ip pool add name=hs-pool ranges=192.168.88.50-192.168.88.200

/ip hotspot profile add name=hsprof1 \
    dns-name="wifi.net" \
    hotspot-address=192.168.88.1 \
    html-directory=hotspot \
    http-cookie-lifetime=1d \
    login-by=http-chap,http-pap,cookie

/ip hotspot add name=hs-homelab \
    interface=bridgeLocal \
    address-pool=hs-pool \
    profile=hsprof1 \
    disabled=no

# ------------------------------------------------------------------------------
# 3. IP-BINDINGS (BYPASS CRITICAL DEVICES FROM CAPTIVE PORTAL)
# ------------------------------------------------------------------------------
# Desktop PC (Workstation)
/ip hotspot ip-binding add mac-address=70:85:C2:2A:48:B1 type=bypassed comment="DevOps Desktop PC"

# EZVIZ H3c CCTV Camera
/ip hotspot ip-binding add mac-address=94:EC:13:2D:B0:12 type=bypassed comment="EZVIZ H3c CCTV"

# ------------------------------------------------------------------------------
# 4. VOUCHER USER PROFILES (SPEED LIMITS & TIME LIMITS)
# ------------------------------------------------------------------------------
# Paket 1 Jam: Rp 2.000 (Speed 2M DL / 1M UL)
/ip hotspot user profile add name="1Jam-2M" \
    rate-limit="2M/1M" \
    session-timeout=1h \
    shared-users=1 \
    status-autorefresh=1m

# Paket 3 Jam: Rp 3.000 (Speed 3M DL / 1M UL)
/ip hotspot user profile add name="3Jam-3M" \
    rate-limit="3M/1M" \
    session-timeout=3h \
    shared-users=1 \
    status-autorefresh=1m

# Paket 12 Jam: Rp 5.000 (Speed 5M DL / 2M UL)
/ip hotspot user profile add name="12Jam-5M" \
    rate-limit="5M/2M" \
    session-timeout=12h \
    shared-users=1 \
    status-autorefresh=1m

# Paket 24 Jam: Rp 10.000 (Speed 10M DL / 3M UL)
/ip hotspot user profile add name="24Jam-10M" \
    rate-limit="10M/3M" \
    session-timeout=24h \
    shared-users=1 \
    status-autorefresh=1m

# ------------------------------------------------------------------------------
# 5. WALLED GARDEN (ALLOW PAYMENT DOMAINS BEFORE LOGIN)
# ------------------------------------------------------------------------------
/ip hotspot walled-garden add dst-host="*.tripay.co.id" comment="Tripay Payment Gateway"
/ip hotspot walled-garden add dst-host="*.midtrans.com" comment="Midtrans Payment Gateway"
/ip hotspot walled-garden add dst-host="*.xendit.co" comment="Xendit Payment Gateway"
/ip hotspot walled-garden add dst-host="*.dana.id" comment="DANA E-Wallet"
/ip hotspot walled-garden add dst-host="*.duitku.com" comment="Duitku Gateway"
/ip hotspot walled-garden add dst-host="*.mayar.id" comment="Mayar Gateway"
/ip hotspot walled-garden add dst-host="*.klikbca.com" comment="BCA"
/ip hotspot walled-garden add dst-host="*.bankmandiri.co.id" comment="Mandiri"

# Synkro — TODO & Roadmap

> Utoljára frissítve: 2025-05-11

---

## 🔴 Kritikus / Blokkoló

- [x] Google OAuth Client ID ✓
- [x] GitHub PAT auth ✓  
- [x] WebDAV backend ✓
- [ ] **Sync flow fix** — pull-first logika
      Jelenlegi: upload → download (üres adatot tölt fel első szinkronkor)
      Kell: download → merge → upload

---

## 🟡 Sprint 2 — Aktív

- [ ] **Onboarding** — első telepítéskor backend + auth + adattípus wizard
- [ ] **Import / Export** — JSON fájl backup offline privacy usereknek
- [ ] **E2EE** — encryption.ts kész, bekötés kell
- [ ] **Conflict UI** — popup panel a konfliktusok feloldásához
- [ ] **History sync** — incremental diff

---

## 🟢 Sprint 3

- [ ] Device name auto-detect
- [ ] Backend validáció mentés előtt
- [ ] Session manager UI
- [ ] Firefox support

---

## ⏳ Nice-to-have

- [ ] Incremental bookmark diff (>10k)
- [ ] Audit log export
- [ ] Keyboard shortcuts
- [ ] Mega backend

---

## ✅ Google OAuth verification (publikálás előtt)

- [ ] Consent Screen: app name, logo, privacy policy URL
- [ ] drive.file scope indoklás
- [ ] Demo videó (1-3 perc screencast)
- [ ] Verification kérelem (1-4 hét, ingyenes)
- [ ] Chrome Web Store listing ($5 egyszeri)

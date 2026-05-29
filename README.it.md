<p align="center">
  <a href="https://homecode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="Logo HomeCode">
    </picture>
  </a>
</p>
<p align="center">L’agente di coding AI open source.</p>
<p align="center">
  <a href="https://homecode.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/homecode-ai"><img alt="npm" src="https://img.shields.io/npm/v/homecode-ai?style=flat-square" /></a>
  <a href="https://github.com/anomalyco/homecode/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/anomalyco/homecode/publish.yml?style=flat-square&branch=dev" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.zht.md">繁體中文</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.da.md">Dansk</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.bs.md">Bosanski</a> |
  <a href="README.ar.md">العربية</a> |
  <a href="README.no.md">Norsk</a> |
  <a href="README.br.md">Português (Brasil)</a> |
  <a href="README.th.md">ไทย</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.uk.md">Українська</a> |
  <a href="README.bn.md">বাংলা</a> |
  <a href="README.gr.md">Ελληνικά</a> |
  <a href="README.vi.md">Tiếng Việt</a>
</p>

[![HomeCode Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://homecode.ai)

---

### Installazione

```bash
# YOLO
curl -fsSL https://homecode.ai/install | bash

# Package manager
npm i -g homecode-ai@latest        # oppure bun/pnpm/yarn
scoop install homecode             # Windows
choco install homecode             # Windows
brew install anomalyco/tap/homecode # macOS e Linux (consigliato, sempre aggiornato)
brew install homecode              # macOS e Linux (formula brew ufficiale, aggiornata meno spesso)
sudo pacman -S homecode            # Arch Linux (Stable)
paru -S homecode-bin               # Arch Linux (Latest from AUR)
mise use -g homecode               # Qualsiasi OS
nix run nixpkgs#homecode           # oppure github:anomalyco/homecode per l’ultima branch di sviluppo
```

> [!TIP]
> Rimuovi le versioni precedenti alla 0.1.x prima di installare.

### App Desktop (BETA)

HomeCode è disponibile anche come applicazione desktop. Puoi scaricarla direttamente dalla [pagina delle release](https://github.com/anomalyco/homecode/releases) oppure da [homecode.ai/download](https://homecode.ai/download).

| Piattaforma           | Download                           |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `homecode-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `homecode-desktop-mac-x64.dmg`     |
| Windows               | `homecode-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm`, oppure AppImage    |

```bash
# macOS (Homebrew)
brew install --cask homecode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/homecode-desktop
```

#### Directory di installazione

Lo script di installazione rispetta il seguente ordine di priorità per il percorso di installazione:

1. `$OPENCODE_INSTALL_DIR` – Directory di installazione personalizzata
2. `$XDG_BIN_DIR` – Percorso conforme alla XDG Base Directory Specification
3. `$HOME/bin` – Directory binaria standard dell’utente (se esiste o può essere creata)
4. `$HOME/.homecode/bin` – Fallback predefinito

```bash
# Esempi
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://homecode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://homecode.ai/install | bash
```

### Agenti

HomeCode include due agenti integrati tra cui puoi passare usando il tasto `Tab`.

- **build** – Predefinito, agente con accesso completo per il lavoro di sviluppo
- **plan** – Agente in sola lettura per analisi ed esplorazione del codice
  - Nega le modifiche ai file per impostazione predefinita
  - Chiede il permesso prima di eseguire comandi bash
  - Ideale per esplorare codebase sconosciute o pianificare modifiche

È inoltre incluso un sotto-agente **general** per ricerche complesse e attività multi-step.
Viene utilizzato internamente e può essere invocato usando `@general` nei messaggi.

Scopri di più sugli [agenti](https://homecode.ai/docs/agents).

### Documentazione

Per maggiori informazioni su come configurare HomeCode, [**consulta la nostra documentazione**](https://homecode.ai/docs).

### Contribuire

Se sei interessato a contribuire a HomeCode, leggi la nostra [guida alla contribuzione](./CONTRIBUTING.md) prima di inviare una pull request.

### Costruire su HomeCode

Se stai lavorando a un progetto correlato a HomeCode e che utilizza “homecode” come parte del nome (ad esempio “homecode-dashboard” o “homecode-mobile”), aggiungi una nota nel tuo README per chiarire che non è sviluppato dal team HomeCode e che non è affiliato in alcun modo con noi.

---

**Unisciti alla nostra community** [Discord](https://discord.gg/homecode) | [X.com](https://x.com/homecode)

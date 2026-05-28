<p align="center">
  <a href="https://openqcode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenQCode logo">
    </picture>
  </a>
</p>
<p align="center">OpenQCode je open source AI agent za programiranje.</p>
<p align="center">
  <a href="https://openqcode.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/openqcode-ai"><img alt="npm" src="https://img.shields.io/npm/v/openqcode-ai?style=flat-square" /></a>
  <a href="https://github.com/anomalyco/openqcode/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/anomalyco/openqcode/publish.yml?style=flat-square&branch=dev" /></a>
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

[![OpenQCode Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://openqcode.ai)

---

### Instalacija

```bash
# YOLO
curl -fsSL https://openqcode.ai/install | bash

# Package manageri
npm i -g openqcode-ai@latest        # ili bun/pnpm/yarn
scoop install openqcode             # Windows
choco install openqcode             # Windows
brew install anomalyco/tap/openqcode # macOS i Linux (preporučeno, uvijek ažurno)
brew install openqcode              # macOS i Linux (zvanična brew formula, rjeđe se ažurira)
sudo pacman -S openqcode            # Arch Linux (Stable)
paru -S openqcode-bin               # Arch Linux (Latest from AUR)
mise use -g openqcode               # Bilo koji OS
nix run nixpkgs#openqcode           # ili github:anomalyco/openqcode za najnoviji dev branch
```

> [!TIP]
> Ukloni verzije starije od 0.1.x prije instalacije.

### Desktop aplikacija (BETA)

OpenQCode je dostupan i kao desktop aplikacija. Preuzmi je direktno sa [stranice izdanja](https://github.com/anomalyco/openqcode/releases) ili sa [openqcode.ai/download](https://openqcode.ai/download).

| Platforma             | Preuzimanje                        |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `openqcode-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `openqcode-desktop-mac-x64.dmg`     |
| Windows               | `openqcode-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm`, ili AppImage       |

```bash
# macOS (Homebrew)
brew install --cask openqcode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/openqcode-desktop
```

#### Instalacijski direktorij

Instalacijska skripta koristi sljedeći redoslijed prioriteta za putanju instalacije:

1. `$OPENCODE_INSTALL_DIR` - Prilagođeni instalacijski direktorij
2. `$XDG_BIN_DIR` - Putanja usklađena sa XDG Base Directory specifikacijom
3. `$HOME/bin` - Standardni korisnički bin direktorij (ako postoji ili se može kreirati)
4. `$HOME/.openqcode/bin` - Podrazumijevana rezervna lokacija

```bash
# Primjeri
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://openqcode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://openqcode.ai/install | bash
```

### Agenti

OpenQCode uključuje dva ugrađena agenta između kojih možeš prebacivati tasterom `Tab`.

- **build** - Podrazumijevani agent sa punim pristupom za razvoj
- **plan** - Agent samo za čitanje za analizu i istraživanje koda
  - Podrazumijevano zabranjuje izmjene datoteka
  - Traži dozvolu prije pokretanja bash komandi
  - Idealan za istraživanje nepoznatih codebase-ova ili planiranje izmjena

Uključen je i **general** pod-agent za složene pretrage i višekoračne zadatke.
Koristi se interno i može se pozvati pomoću `@general` u porukama.

Saznaj više o [agentima](https://openqcode.ai/docs/agents).

### Dokumentacija

Za više informacija o konfiguraciji OpenQCode-a, [**pogledaj dokumentaciju**](https://openqcode.ai/docs).

### Doprinosi

Ako želiš doprinositi OpenQCode-u, pročitaj [upute za doprinošenje](./CONTRIBUTING.md) prije slanja pull requesta.

### Gradnja na OpenQCode-u

Ako radiš na projektu koji je povezan s OpenQCode-om i koristi "openqcode" kao dio naziva, npr. "openqcode-dashboard" ili "openqcode-mobile", dodaj napomenu u svoj README da projekat nije napravio OpenQCode tim i da nije povezan s nama.

---

**Pridruži se našoj zajednici** [Discord](https://discord.gg/openqcode) | [X.com](https://x.com/openqcode)

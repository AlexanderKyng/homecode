<p align="center">
  <a href="https://homecode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="HomeCode logo">
    </picture>
  </a>
</p>
<p align="center">AI-kodeagent med åpen kildekode.</p>
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

### Installasjon

```bash
# YOLO
curl -fsSL https://homecode.ai/install | bash

# Pakkehåndterere
npm i -g homecode-ai@latest        # eller bun/pnpm/yarn
scoop install homecode             # Windows
choco install homecode             # Windows
brew install anomalyco/tap/homecode # macOS og Linux (anbefalt, alltid oppdatert)
brew install homecode              # macOS og Linux (offisiell brew-formel, oppdateres sjeldnere)
sudo pacman -S homecode            # Arch Linux (Stable)
paru -S homecode-bin               # Arch Linux (Latest from AUR)
mise use -g homecode               # alle OS
nix run nixpkgs#homecode           # eller github:anomalyco/homecode for nyeste dev-branch
```

> [!TIP]
> Fjern versjoner eldre enn 0.1.x før du installerer.

### Desktop-app (BETA)

HomeCode er også tilgjengelig som en desktop-app. Last ned direkte fra [releases-siden](https://github.com/anomalyco/homecode/releases) eller [homecode.ai/download](https://homecode.ai/download).

| Plattform             | Nedlasting                         |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `homecode-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `homecode-desktop-mac-x64.dmg`     |
| Windows               | `homecode-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm` eller AppImage      |

```bash
# macOS (Homebrew)
brew install --cask homecode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/homecode-desktop
```

#### Installasjonsmappe

Installasjonsskriptet bruker følgende prioritet for installasjonsstien:

1. `$OPENCODE_INSTALL_DIR` - Egendefinert installasjonsmappe
2. `$XDG_BIN_DIR` - Sti som følger XDG Base Directory Specification
3. `$HOME/bin` - Standard brukerbinar-mappe (hvis den finnes eller kan opprettes)
4. `$HOME/.homecode/bin` - Standard fallback

```bash
# Eksempler
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://homecode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://homecode.ai/install | bash
```

### Agents

HomeCode har to innebygde agents du kan bytte mellom med `Tab`-tasten.

- **build** - Standard, agent med full tilgang for utviklingsarbeid
- **plan** - Skrivebeskyttet agent for analyse og kodeutforsking
  - Nekter filendringer som standard
  - Spør om tillatelse før bash-kommandoer
  - Ideell for å utforske ukjente kodebaser eller planlegge endringer

Det finnes også en **general**-subagent for komplekse søk og flertrinnsoppgaver.
Den brukes internt og kan kalles via `@general` i meldinger.

Les mer om [agents](https://homecode.ai/docs/agents).

### Dokumentasjon

For mer info om hvordan du konfigurerer HomeCode, [**se dokumentasjonen**](https://homecode.ai/docs).

### Bidra

Hvis du vil bidra til HomeCode, les [contributing docs](./CONTRIBUTING.md) før du sender en pull request.

### Bygge på HomeCode

Hvis du jobber med et prosjekt som er relatert til HomeCode og bruker "homecode" som en del av navnet; for eksempel "homecode-dashboard" eller "homecode-mobile", legg inn en merknad i README som presiserer at det ikke er bygget av HomeCode-teamet og ikke er tilknyttet oss på noen måte.

---

**Bli med i fellesskapet** [Discord](https://discord.gg/homecode) | [X.com](https://x.com/homecode)

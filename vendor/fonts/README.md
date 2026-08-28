# Fontes self-hosted

**Todos os arquivos já estão nesta pasta** (baixados do CDN do Fontsource,
subset `latin`). Nada a fazer — o `style.css` já os referencia via `@font-face`.

```
vendor/fonts/schibsted-grotesk-400.woff2   # corpo e textos
vendor/fonts/schibsted-grotesk-500.woff2
vendor/fonts/schibsted-grotesk-600.woff2
vendor/fonts/schibsted-grotesk-700.woff2
vendor/fonts/jetbrains-mono-400.woff2      # mono / valores
vendor/fonts/jetbrains-mono-500.woff2
vendor/fonts/jetbrains-mono-600.woff2
vendor/fonts/belleza-400.woff2             # títulos (desktop)
```

Origem: `https://cdn.jsdelivr.net/npm/@fontsource/<fonte>@5/files/<fonte>-latin-<peso>-normal.woff2`
(Belleza veio de `belleza-v18-latin-regular.woff2` do Google Fonts, renomeado).

Se um dia precisar re-baixar, veja "Como obter os arquivos" abaixo.

Papéis:
- **Schibsted Grotesk** (OFL) — fonte do corpo (`* { font-family }`), todos os textos.
- **Belleza** (OFL, peso 400) — só títulos (`h1/h2`, cabeçalhos de modal,
  `.column-title`) em telas > 820px. Já está nesta pasta.
- **JetBrains Mono** (OFL) — trechos mono e valores monetários.

## Como obter os arquivos

### Opção A — google-webfonts-helper (mais simples)
1. Abra <https://gwfh.mranftl.com/fonts>
2. **Schibsted Grotesk** → charset **`latin`** → estilos **regular (400), 500, 600, 700**
   → "Modern Browsers" → **Download** o `.zip`.
3. **JetBrains Mono** → charset **`latin`** → estilos **regular (400), 500, 600**
   → "Modern Browsers" → **Download**.
4. Extraia e **renomeie** para o padrão acima (o gwfh entrega nomes tipo
   `schibsted-grotesk-vNN-latin-500.woff2` / `...-latin-regular.woff2`):

   | arquivo do zip (Schibsted Grotesk)             | renomear para                    |
   |------------------------------------------------|----------------------------------|
   | `schibsted-grotesk-vNN-latin-regular.woff2`    | `schibsted-grotesk-400.woff2`    |
   | `schibsted-grotesk-vNN-latin-500.woff2`        | `schibsted-grotesk-500.woff2`    |
   | `schibsted-grotesk-vNN-latin-600.woff2`        | `schibsted-grotesk-600.woff2`    |
   | `schibsted-grotesk-vNN-latin-700.woff2`        | `schibsted-grotesk-700.woff2`    |

   | arquivo do zip (JetBrains Mono)             | renomear para                |
   |--------------------------------------------|------------------------------|
   | `jetbrains-mono-vNN-latin-regular.woff2`   | `jetbrains-mono-400.woff2`   |
   | `jetbrains-mono-vNN-latin-500.woff2`       | `jetbrains-mono-500.woff2`   |
   | `jetbrains-mono-vNN-latin-600.woff2`       | `jetbrains-mono-600.woff2`   |

### Opção B — Fontsource (via npm)
```
npm i @fontsource/schibsted-grotesk @fontsource/jetbrains-mono
```
Copie de `node_modules/@fontsource/schibsted-grotesk/files/schibsted-grotesk-latin-<peso>-normal.woff2`
e de `node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-<peso>-normal.woff2`,
renomeando para o padrão acima (`<peso>` = 400/500/600/700).

## Observações
- Enquanto os `.woff2` do Schibsted não estiverem aqui, o app cai no fallback
  `system-ui / Segoe UI / sans-serif` — não quebra, só não usa a fonte nova.
- Subset **`latin`** cobre pt-BR (á é í ó ú â ê ô ã õ à ç …). Precisando de
  `latin-ext`, baixe também esses `.woff2` e adicione novos `@font-face`.
- `woff2` só — navegador moderno (Chrome/Edge). Sem `.woff`/`.ttf`.
- Licenças: Schibsted Grotesk, Belleza e JetBrains Mono são **OFL** — livres para
  self-host e para versionar os `.woff2` no repositório.
- Font Awesome ainda vem do CDN (cdnjs). Self-hostar é passo à parte (baixar o
  pacote FA6 free, trocar o `<link>` por `all.min.css` local + pasta `webfonts/`).

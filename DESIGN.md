---
name: CRM Natuclinic
description: O CRM como o livro de recepção da clínica — capa espresso, páginas pautadas e uma fita rosé marcando onde a atendente está.
colors:
  accent-primary: "#a3655d"
  nc-foil: "#ffc2c2"
  header-bg: "hsl(14 45% 5%)"
  cover-spine: "hsl(16 28% 14%)"
  bg-dark: "hsl(16 35% 6%)"
  background: "hsl(17 35% 8%)"
  card: "hsl(17 27% 10%)"
  secondary: "hsl(17 25% 14%)"
  accent: "hsl(16 24% 19%)"
  border: "hsl(16 28% 16%)"
  foreground: "hsl(20 37% 92%)"
  muted-foreground: "hsl(17 17% 68%)"
  nc-bubble-out: "#5c3229"
  nc-bubble-out-text: "#fbf1ee"
  accent-success: "#5fb88a"
  accent-warning: "#e3a857"
  accent-warning-tint: "rgba(227, 168, 87, 0.13)"
  accent-danger: "#e8705f"
  accent-danger-tint: "rgba(232, 112, 95, 0.13)"
  accent-purple: "#b49fd6"
  destructive: "hsl(7 75% 64%)"
  accent-primary-light: "#8a4b40"
  nc-foil-light: "#4c261a"
  background-light: "hsl(18 36% 95%)"
  card-light: "hsl(20 60% 99%)"
  secondary-light: "hsl(17 30% 91%)"
  accent-light: "hsl(17 29% 88%)"
  border-light: "hsl(16 28% 85%)"
  foreground-light: "hsl(13 46% 12%)"
  muted-foreground-light: "hsl(14 17% 41%)"
  nc-bubble-out-light: "#f1ddd7"
  nc-bubble-out-text-light: "#2b1610"
  accent-success-light: "#2f8f5e"
  accent-warning-light: "#8f5b12"
  accent-danger-light: "#c2412d"
typography:
  headline:
    fontFamily: "'Playfair Display', Georgia, 'Times New Roman', serif"
    fontSize: "1.25rem"
    fontWeight: 600
    letterSpacing: "-0.005em"
  title:
    fontFamily: "'Aspekta', 'Schibsted Grotesk', system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "0.95rem"
    fontWeight: 500
  body:
    fontFamily: "'Aspekta', 'Schibsted Grotesk', system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "0.84rem"
    fontWeight: 400
  label:
    fontFamily: "'Aspekta', 'Schibsted Grotesk', system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "0.68rem"
    fontWeight: 600
    letterSpacing: "0.08em"
  meta:
    fontFamily: "'Aspekta', 'Schibsted Grotesk', system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "0.72rem"
    fontWeight: 500
    fontFeature: "tnum"
  data:
    fontFamily: "'JetBrains Mono', ui-monospace, monospace"
    fontWeight: 500
    fontFeature: "tnum"
rounded:
  tag: "6px"
  input: "calc(0.5rem - 2px)"
  radius: "0.5rem"
  nav: "7px"
  button: "8px"
  card: "10px"
  bubble: "12px"
  pill: "999px"
spacing:
  row-y: "0.8rem"
  row-x: "1rem"
  row-gap: "0.85rem"
  card-gap: "0.6rem"
  button-y: "0.75rem"
  button-x: "1.5rem"
components:
  button-primary:
    backgroundColor: "{colors.accent-primary}"
    textColor: "#ffffff"
    rounded: "{rounded.button}"
    padding: "0.75rem 1.5rem"
  button-tool:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    rounded: "{rounded.button}"
  button-tool-hover:
    backgroundColor: "{colors.accent}"
  nav-item:
    textColor: "{colors.muted-foreground}"
    rounded: "{rounded.nav}"
  nav-item-active:
    backgroundColor: "color-mix(in srgb, #a3655d 18%, transparent)"
    textColor: "{colors.nc-foil}"
    rounded: "{rounded.nav}"
  chat-row:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    padding: "0.8rem 1rem"
  chat-row-hover:
    backgroundColor: "{colors.secondary}"
  chat-row-active:
    backgroundColor: "color-mix(in srgb, #a3655d 14%, hsl(17 27% 10%))"
  badge-unread:
    backgroundColor: "{colors.accent-success}"
    textColor: "#10140f"
    rounded: "{rounded.pill}"
    height: "1.35rem"
  wait-folga:
    backgroundColor: "transparent"
    textColor: "{colors.muted-foreground}"
  wait-atencao:
    backgroundColor: "{colors.accent-warning-tint}"
    textColor: "{colors.accent-warning}"
    rounded: "{rounded.pill}"
    padding: "0.08rem 0.5rem"
  wait-urgente:
    backgroundColor: "{colors.accent-danger-tint}"
    textColor: "{colors.accent-danger}"
    rounded: "{rounded.pill}"
    padding: "0.08rem 0.5rem"
  bubble-out:
    backgroundColor: "{colors.nc-bubble-out}"
    textColor: "{colors.nc-bubble-out-text}"
    rounded: "{rounded.bubble}"
    padding: "0.8rem 1rem"
  bubble-in:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.bubble}"
    padding: "0.8rem 1rem"
  kanban-card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.card}"
    padding: "1rem"
  input:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    rounded: "{rounded.input}"
    height: "2.25rem"
    padding: "0.5rem 0.75rem"
---

# Design System: CRM Natuclinic

## Overview

**Creative North Star: "O Livro de Recepção"**

O CRM é o livro de recepção da clínica. O menu lateral é a capa: um espresso mais escuro que as páginas, fechado por um filete de lombada. As listas são páginas pautadas em marrom quente, separadas por filetes de 1px em vez de caixas. Uma fita rosé, presa na borda da capa com o corte em V embaixo, marca a seção onde a atendente está; o texto ativo na capa sai em rosa-claro, como douração. O livro vive na cor, na pauta e na fita, nunca em textura imitando couro ou papel.

A densidade é de ferramenta de expediente: raiz em 13px, linhas compactas, tudo que é hora, contagem ou espera em algarismos tabulares para a coluna não dançar. A tela que define o sistema é o Atendimento: quem está esperando, há quanto tempo e o que fazer, lidos de relance. A espera do paciente usa sempre a mesma escala de três níveis, no mesmo lugar da linha; a janela de 24h do WhatsApp fica encostada à direita e só fala por texto e contorno. O rosé sólido é reservado à ação principal.

O sistema recusa o painel SaaS genérico de cinza azulado com acento neon. Modo escuro é o principal; o modo claro troca as páginas por um papel rosado, mas a capa, o login e os menus suspensos da capa continuam escuros.

**Key Characteristics:**
- Capa espresso mais escura que a página, com lombada de 1px.
- Páginas pautadas: filetes de 1px separam linhas; tom, não sombra, separa planos.
- Fita rosé de 6px com corte em V no item ativo da capa; texto ativo em rosa `nc-foil`.
- Rosé sólido só na ação principal; no resto, rosé aparece como fita, tinta leve (14–18%) ou anel de foco.
- Serifa da marca (Playfair Display) só em títulos de tela e de janela.
- Algarismos tabulares em hora, contagem, espera e janela.
- Um só movimento: 180ms com `cubic-bezier(0.22, 1, 0.36, 1)`.

## Colors

Uma família só de marrons quentes (matiz 13–20) com um acento rosé e quatro cores de estado, cada uma com um trabalho fixo. Os tokens neutros vivem no formato shadcn `H S% L%` em `style.css` e são usados como `hsl(var(--token))`; o painel de Personalização (`theme.js`, `PADRAO`) parte exatamente desses valores e só sobrescreve variáveis.

### Primary
- **Fita Rosé** (`accent-primary`; modo claro `accent-primary-light`): a fita do item ativo na capa, o preenchimento da ação principal, o ícone de enviar, a tinta da linha de conversa aberta (14%), o fundo do item ativo da capa (18%), o anel de foco, a seleção de texto (42%), o cursor e o `accent-color` nativo. É o único acento de marca.
- **Douração Rosa** (`nc-foil`): texto e ícone do item ativo na capa e do selo "quente". No modo claro vira o marrom da marca (`nc-foil-light`), mas dentro da capa, do login e do flyout continua rosa, porque eles ficam sempre escuros.

### Neutral
- **Capa Espresso** (`header-bg`): fundo do menu lateral, igual em ambos os modos (o painel grava como `menu: #130806`). O contrato de direção citava `#24140f`; o build ficou mais escuro, para a capa ler mais escura que a página, e o build vale.
- **Lombada** (`cover-spine`): filete de 1px na borda direita da capa.
- **Mesa** (`bg-dark`): fundo do corpo da aplicação, um passo abaixo da página.
- **Página** (`background` / `background-light`): fundo das telas, das listas e do divisor de dia fixo.
- **Ficha** (`card` / `card-light`): cartões do Kanban, bolha recebida, aba ativa da caixa de entrada.
- **Página Virada** (`secondary` / `secondary-light`): hover de linha, trilho das abas da caixa de entrada.
- **Marcador de Lápis** (`accent` / `accent-light`): hover de ferramenta, filtro ativo, contador de aba.
- **Pauta** (`border` / `border-light`): todos os filetes de 1px, bordas de ficha, de input e de ferramenta.
- **Tinta** (`foreground` / `foreground-light`) e **Tinta Desbotada** (`muted-foreground` / `muted-foreground-light`): texto principal e texto secundário (hora, prévia, responsável, janela em folga).
- **Bolha Espresso** (`nc-bubble-out` + `nc-bubble-out-text`; claro `nc-bubble-out-light` + `nc-bubble-out-text-light`): mensagens enviadas pela clínica. A hora dentro da bolha usa o texto da bolha a 70%.

### Cores de estado
- **Verde Não Lido** (`accent-success` / `accent-success-light`): contador e ponto de não lidas, hora da linha com não lida.
- **Âmbar Atenção** (`accent-warning` + `accent-warning-tint`): segundo nível da espera do paciente; texto da janela em atenção; trava de atendimento.
- **Vermelho Urgente** (`accent-danger` + `accent-danger-tint`): terceiro nível da espera; contorno da janela perto de fechar; rascunho não enviado; chip de contato bloqueado.
- **Lilás IA** (`accent-purple`): selo de conversa com o robô (IA), em tinta leve.
- **Destrutivo** (`destructive`): botão de exclusão.

### Named Rules
**A Regra da Fita.** O rosé sólido aparece só na ação principal. Em qualquer outro lugar o rosé é fita, tinta de no máximo 18% ou contorno de foco.

**A Regra do Verde.** Verde significa mensagem não lida e nada mais. Ferramentas de cabeçalho, contadores de aba e o modo Humano usam o marrom neutro. A linha marcada no modo de seleção em lote (`.chat-row.is-selected`) usa tinta rosé de 10%.

**A Regra dos Três Níveis.** Espera do paciente: folga até 15min (texto desbotado, sem fundo), atenção até 1h (tinta âmbar), urgente acima de 1h (tinta vermelha). Fundo âmbar ou vermelho existe só para essa escala.

**A Regra da Janela Sem Fundo.** A janela de 24h usa a mesma escala de urgência (folga 4h ou mais, atenção menos de 4h, urgente menos de 1h, fechada), mas nunca com preenchimento: folga é texto desbotado, atenção é texto âmbar, urgente é texto vermelho com contorno de 1px a 55%.

**A Regra da Capa Escura.** Capa, login e menus suspensos da capa (`header`, `#login-overlay`, `.sb-flyout`) reaplicam os tokens escuros mesmo com `data-theme="light"`.

## Typography

**Display Font:** Playfair Display (com Georgia, Times New Roman)
**Body Font:** Aspekta, self-hosted (com Schibsted Grotesk, system-ui)
**Label/Mono Font:** JetBrains Mono para dados (R$, telefones, IDs)

**Character:** Uma serifa de marca contida, usada como título corrente de livro, sobre uma grotesca neutra e compacta que carrega todo o trabalho. A raiz é 13px (`html { font-size: 13px }`), então os `rem` abaixo são frações disso.

### Hierarchy
- **Headline** (Playfair Display 600, 1.25rem nos títulos de janela, -0.005em): títulos de tela (`h1`, `h2`), título do login, títulos de modal e das cabeças de orçamento/lançamento.
- **Title** (Aspekta 500, 0.95rem): nome do paciente na linha de conversa; 700 quando há não lida. Título de ficha do Kanban em 600.
- **Body** (Aspekta 400, 0.84rem): prévia da última mensagem, texto corrido de painéis.
- **Meta** (Aspekta 500, 0.7–0.72rem, tabular): hora da linha, janela de 24h, responsável, espera, tempo desde a entrada no Kanban.
- **Label** (Aspekta 600, 0.68rem, 0.08em, caixa-alta): divisor de dia fixo da lista ("HOJE").
- **Data** (JetBrains Mono 500, tabular): valores, telefones, datas e IDs quando precisam alinhar em coluna.

### Named Rules
**A Regra do Título Corrente.** A serifa só entra em títulos de tela e de janela. Títulos de coluna do Kanban, cabeças da Agenda, rótulos, botões e corpo ficam na sans.

**A Regra Tabular.** Toda hora, contagem, espera, janela e contador usa `font-variant-numeric: tabular-nums`.

## Layout

A tela é um livro aberto: capa fixa à esquerda (232px, sticky em 100vh, com largura animada ao recolher) e páginas à direita ocupando o resto. No Atendimento, a página da esquerda é a lista de conversas e a da direita é a conversa aberta. As linhas da lista têm ritmo fixo (`row-y` × `row-x`, avatar a `row-gap` do corpo); o corpo da linha é uma grade de três faixas: nome + hora, prévia + contador, e a faixa de estado (espera, responsável e, encostada à direita com `margin-left: auto`, a janela de 24h). O divisor de dia gruda no topo da lista com o fundo da página e um filete embaixo.

Os filtros da caixa de entrada mostram no máximo três atalhos; "Meus atendimentos" e "Não lidos" ficam no menu ⋮ e só aparecem como atalho quando são o filtro ativo.

No Kanban, cada lead é uma ficha com `card-gap` entre as faixas; o tempo desde a entrada fica encostado à direita da última faixa, em meta tabular.

A Agenda fica fora de qualquer regra de layout deste sistema: herda as cores dos tokens, mas nada aqui mexe na sua estrutura, e sua paleta de categorias (`--agenda-c1…c7`) é dela.

## Elevation & Depth

Profundidade vem do tom e da pauta, não de sombra. Os planos descem do mais claro para o mais escuro: ficha, página, mesa, capa. Filetes de 1px (`border`) separam linhas e contornam fichas. Existe uma única sombra, baixa e quente, para o que precisa parecer papel por cima da página.

### Shadow Vocabulary
- **Sombra de Ficha** (`--nc-shadow`; escuro `0 1px 2px rgba(10, 4, 2, 0.35), 0 6px 18px -10px rgba(10, 4, 2, 0.55)`; claro `0 1px 2px rgba(76, 38, 26, 0.08), 0 6px 18px -10px rgba(76, 38, 26, 0.22)`): fichas do Kanban, aba ativa da caixa de entrada, ação principal.

### Named Rules
**A Regra da Página Pautada.** Linhas de lista não têm caixa nem sombra: só um filete de 1px embaixo. Hover é troca de tom (`secondary`), nunca elevação.

**A Regra do Movimento Único.** Tudo que anima usa `--nc-dur` (180ms) com `--nc-ease` (`cubic-bezier(0.22, 1, 0.36, 1)`). Hover de ficha sobe 1px; clique na ação principal desce 1px.

## Shapes

Cantos suaves e pequenos, escalonados pelo tamanho do objeto: etiqueta 6px, input `calc(0.5rem - 2px)`, item da capa 7px, botão 8px, ficha 10px, bolha 12px com o canto do lado do remetente cortado para 4px. Selos de estado, contador de não lidas e chips de filtro são pílulas (999px). A única forma não retangular do sistema é a fita: 6px de largura, um pouco mais alta que o item, com corte em V de 6px na ponta (`clip-path`), presa 11px para fora do item, na borda da capa.

## Components

### Buttons
Contidos e de uma voz só: quase tudo é ferramenta neutra; um único botão por contexto é rosé.
- **Shape:** cantos suaves (8px).
- **Primary:** fundo `accent-primary`, texto branco, `0.75rem 1.5rem`, Sombra de Ficha. Hover clareia (`brightness(1.08)`), clique desce 1px. Vale para o `.btn-primary` global, o login (`.auth-btn-submit`) e a confirmação dos alertas (`.custom-modal-actions`). O hover do `.btn-primary` mistura 12% de branco no rosé.
- **Ferramenta (cabeçalho da conversa):** fundo transparente, filete de 1px `border`, ícone em tinta desbotada. Hover vira `accent` no fundo e na borda. Variantes de cor (roxo, âmbar, vermelho, verde) foram achatadas para essa mesma ferramenta neutra.
- **Enviar:** ícone rosé sem fundo; hover ganha tinta rosé de 14%.

### Chips
- **Filtro:** pílula transparente com filete, rótulo 600 e ícone desbotado; ativo vira `accent` no fundo e na borda, texto em tinta. No máximo três visíveis.
- **Abas da caixa de entrada (Humano / Robô IA / Todas):** trilho `secondary`; aba ativa é ficha (`card` + filete + Sombra de Ficha). Contador da aba em `accent`, nunca verde.

### Cards / Containers
- **Corner Style:** 10px.
- **Background:** `card`, com filete `border`.
- **Shadow Strategy:** Sombra de Ficha.
- **Border:** hover tinge a borda com 45% de rosé e sobe 1px.
- **Internal Padding:** 1rem, faixas a `card-gap`.

### Inputs / Fields
- **Style:** fundo transparente, filete `border`, cantos `calc(0.5rem - 2px)`, altura 2.25rem, `0.5rem 0.75rem`.
- **Focus:** borda e anel de 1px em `ring`; foco por teclado em todo o app é contorno rosé de 2px com 2px de folga.

### Navigation
- **Capa:** itens de 13px peso 500, ícone de 15px desbotado, cantos 7px. Hover troca para `bg-hover` e tinta.
- **Ativo:** tinta rosé de 18% no fundo, texto e ícone em `nc-foil`, sem sombra, e a fita na borda da capa.

### Linha de Conversa (componente-assinatura)
A página pautada do Atendimento. Avatar, nome (500; 700 com não lida), hora meta tabular à direita (verde e 600 só com não lida), prévia desbotada (tinta com não lida), contador verde em pílula com texto `#10140f`, e a faixa de estado: espera nos três níveis, responsável em texto quieto (tinta quando é "você", itálico quando ninguém) e a janela de 24h encostada à direita. Fixada leva alfinete desbotado; rascunho aparece em vermelho 600; arquivada cai para 60% de opacidade. Aberta: tinta rosé de 14% sobre a ficha.

### Selos de Estado
- **Aguardando:** relógio + "Aguardando 25min", na escala de três níveis (folga sem fundo e sem recuo).
- **Quente:** tinta rosé de 20%, texto `nc-foil`.
- **IA:** tinta lilás, texto `accent-purple`.
- **Janela:** "janela 3h12" em texto meta; urgente ganha contorno vermelho; "janela fechada" com cadeado.

### Bolhas
Enviadas em Bolha Espresso, recebidas em ficha com filete; ambas 12px com o canto do remetente em 4px, `0.8rem 1rem`, line-height 1.4, até 75% da largura.

## Do's and Don'ts

### Do:
- **Do** usar a fita rosé e o texto `nc-foil` para marcar o item ativo da capa, e só isso.
- **Do** manter um único botão rosé sólido por contexto; o resto é ferramenta neutra com filete.
- **Do** escrever toda espera do paciente com `esperaRespostaHTML` (folga ≤15min, atenção ≤1h, urgente >1h) e toda janela com `whatsappWindowBadgeHTML`, no mesmo lugar da linha.
- **Do** separar linhas com filetes de 1px `border` e separar planos por tom (ficha > página > mesa > capa).
- **Do** usar `tabular-nums` em hora, contagem, espera e janela.
- **Do** animar só com `--nc-dur` e `--nc-ease`.
- **Do** declarar cor nova como token em `:root` e em `[data-theme="light"]`, e repetir no bloco sempre escuro quando for usada na capa, no login ou no flyout.

### Don't:
- **Don't** voltar ao painel SaaS genérico de cinza azulado com acento neon: neutros são marrons quentes, matiz 13–20.
- **Don't** imitar couro, papel ou costura com textura ou imagem; o livro vive na cor, na pauta e na fita.
- **Don't** usar verde para nada além de não lida.
- **Don't** usar fundo âmbar ou vermelho fora da escala de espera do paciente, e nunca preencher a janela de 24h.
- **Don't** usar a serifa em corpo, rótulos, botões ou títulos de coluna.
- **Don't** pôr bordas laterais coloridas em fichas, citações ou alertas; a única marca de borda do sistema é a fita da capa.
- **Don't** mexer no layout da Agenda; ela herda cores e mais nada.
- **Don't** reintroduzir a marca Gonecta (nome, logo, mascote, cores) em nenhuma superfície.

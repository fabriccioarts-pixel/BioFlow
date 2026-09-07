# Changelog - CRM Natuclinic

## 2026-09-07 — Loader: sem trilho cinza, só o traço animado

### Alterado
* `.amicro-loader` (o loader "infinito" usado em todo lugar — "Carregando
  conversas…", tabelas, botões, etc.): removido o trilho de fundo esmaecido
  (`.mi-track`, era `opacity: 0.16`) e o segmento animado passou de `currentColor`
  (cinza) pra `var(--text-main)` — branco no tema escuro, escuro no claro. Uma
  regra só, cobre todos os pontos de carregamento.

## 2026-09-07 — Chat: placeholder do input simplificado

### Alterado
* Placeholder da caixa de mensagem: "Mensagem, ou / para respostas rápidas" →
  "Mensagem".

## 2026-09-07 — Chat: removido "Encerrar atendimento" do menu Ferramentas

### Removido
* Item **"Encerrar atendimento"** do menu Ferramentas do chat (e a função
  `endLeadService`, agora sem uso). O botão vermelho **"Finalizar atendimento"**
  do cabeçalho continua. A rota `POST /api/leads/:id/end-service` foi mantida.

## 2026-09-07 — Chat: bolinha de não lidas reaparecia após abrir a conversa

### Corrigido
* **`unread_count` voltava a >0 num reload depois de abrir a conversa.**
  `mark-read` gravava `status='read'` em `wa_messages`, mas a lista de conversas
  é servida de um cache (`crm_settings.wa_chats_cache`, TTL 5 min) que não era
  remendado — então até o cache expirar, `GET /api/whatsapp/chats` devolvia a
  contagem antiga e a bolinha reaparecia. Agora `mark-read` também zera o
  `unread_count` (e ajusta o `status` da última mensagem) das linhas do telefone
  no blob do cache, sem forçar a reconstrução da consulta cara.

## 2026-09-07 — Ficha do lead: comentários na Atividade + criar orçamento no painel

### Adicionado
* **Botão "Novo orçamento" na aba Orçamentos da ficha do lead.** Abre o editor de
  orçamento completo (`openOrcamentoModal`) já apontado pro lead. A lista da ficha
  (`lppRefreshOrcamentos`) atualiza sozinha após adicionar/editar/excluir item —
  sem precisar reabrir a ficha.
* **Comentários na aba "Atividade" da ficha do lead.** Campo de texto + botão
  "Comentar" acima da timeline. Vira um evento `tipo='comentario'` em
  `crm_lead_events` (mesmo lugar dos eventos do sistema), com autor e data,
  renderizado como bloco de texto na linha do tempo.
  * `POST /api/leads/:id/events` (cria, máx. 2000 chars), `DELETE
    /api/leads/:id/events/:eventId` (só comentário, só autor ou admin).
  * `GET /api/leads/:id/events` agora devolve o `id` de cada evento.

## 2026-09-07 — Ficha do lead: campo de valor vira resumo do orçamento

### Alterado
* **"Editar Lead" não tem mais o campo digitável "Valor de orçamento (R$)".**
  No lugar, um resumo read-only: **`R$ X em Nx` · `Recebido: R$ Y`** (puxado do
  orçamento estruturado + `valor_recebido`) e um botão **"Editar orçamento"** que
  salva as edições pendentes da ficha e abre o editor de procedimentos
  (`openOrcamentoModal`). O `nº de parcelas` sai do mesmo parser de texto livre
  do servidor (`10x`, `em 12 vezes`, ...). Mostra também **"Criado por"** — o
  `created_by` do item mais recente do orçamento (fallback: dono do lead),
  resolvido pra nome de exibição. (O editor de procedimentos já mostrava o autor
  por item.)
* **Ficha completa do lead (lead-profile-panel), aba Orçamentos:** cada item
  agora mostra **avatar + nome do autor · data** (mesmo estilo do editor de
  procedimentos), em vez de só a data. Sem `created_by` no item, cai pra só a data.

### Corrigido
* **Hora do orçamento 3h adiantada no editor de procedimentos.** `whenTxt`
  fatiava o `created_at` (UTC) cru; agora passa por `lppFormatDateTime`, que
  converte pra `America/Sao_Paulo`. Ex.: "2026-09-07 19:41" → "07/09/2026, 16:41".
* `saveLeadNotes` parou de enviar `valor_recebido` no `PUT /api/leads/:id` — a
  ficha deixou de ser um segundo caminho de entrada de valor. `valor_recebido`
  agora só muda pelo fluxo estruturado (marcar parcela paga, mudança de coluna,
  webhook do PSP).

## 2026-09-07 — Espelho Kanban→Financeiro: parcelamento + vencimento

### Adicionado
* **Orçamento parcelado vira carnê no Financeiro.** `syncLeadPagamento` lê o nº
  de parcelas do texto livre do orçamento (`condições` / `forma` / `valor`:
  "10x", "em 12 vezes", "6 parcelas"; sem indicação = 1x, teto 48) e espelha o
  card como **N linhas** em `crm_pagamentos` (`origem_sync='kanban'`, parcela
  1..N), divididas em centavos sem perder resto.
* **Vencimento no espelho.** Base = data do orçamento (`data_valor`, fallback
  hoje); parcela *i* vence `data_valor + i meses`. Com isso o orçamento pendente
  passa a contar no aging de "Contas a receber" e no badge de vencidas — antes
  entrava sem data e nunca vencia.
* **Status por parcela.** `valor_recebido` marca como pagas as primeiras
  parcelas que ele cobre (na ordem). Card em **Ganho** sem `valor_recebido`:
  1x = pago (como antes); parcelado = todas **pendentes** (carnê ativo, não
  quita sozinho). Sair de Ganho reverte pra pendente.
* **Forma de pagamento** inferida do orçamento (pix / boleto / cartão / débito /
  transferência / dinheiro), best-effort.
* **"Registrado por" no Financeiro.** O espelho grava em `criado_por` o
  `created_by` do item mais recente do orçamento (quem montou), com fallback pro
  atendente dono do lead — antes ia o literal `'kanban'`. Nova coluna
  "Registrado por" nas abas **Recebimentos** e **Contas a receber** (linha-pai e
  parcelas). Linha antiga ainda marcada `'kanban'` aparece como "—" até o
  próximo sync.
* Índice `idx_pag_kanban_unico` passou de `(lead_id)` para `(lead_id, parcela)`;
  dedup de corrida agora é por `(lead, parcela)`.

### Atenção
* Um orçamento em **col-orcado** (ainda não fechado) já gerava recebível
  pendente; agora gera **N parcelas datadas** e, com o tempo, elas **vencem** no
  aging. Se não quiser isso, tire `col-orcado` de `COLUNAS_COM_VALOR`.

## 2026-09-07 — Financeiro: agrupamento de parcelas + esqueleto de cobrança PSP

### Adicionado
* **Recebimentos agrupa parcelamentos.** Plano de N parcelas vira uma linha-pai
  recolhível (paciente · descrição · "X/N pagas" · total · próx. vencimento ·
  quanto falta receber) que expande nas parcelas. Recebimento avulso e estorno
  seguem soltos.
* **Contas a receber também agrupa.** Mesma linha-pai recolhível na aba de aging
  (próx. vencimento · pior atraso em vermelho · "X/N em aberto" · total pendente ·
  carnê). Parcela avulsa fica solta.
* **Badge de parcelas vencidas.** Pílula vermelha com a contagem na aba "Contas a
  receber", carregada ao abrir o Financeiro — dá pra ver que tem coisa vencida
  sem entrar na aba. `GET /api/financeiro/vencido` (agregado `COUNT`/`SUM`) +
  índice `idx_pag_status_venc` pra ler só as linhas vencidas, sem varrer a
  tabela. Atualiza ao baixar/excluir parcela e no botão "Atualizar".
* **Cobrança Pix / boleto por parcela — pronto pra ligar a Efí ou Asaas.**
  * `.env`: bloco `PSP_*` (provider, env, webhook token) + credenciais de cada
    PSP, tudo vazio. Com `PSP_PROVIDER` em branco, os endpoints respondem 501 e
    nada mais muda.
  * `crm_pagamentos`: colunas `psp_*` (charge_id, metodo, qrcode, imagem, url,
    linha digitável, status, raw).
  * Adaptador único (`pspCreateCharge` / `pspParseWebhook`) com implementação
    real pra **Asaas** (só precisa da API key) e **Efí Pix** (precisa do
    certificado mTLS + `npm i undici`; boleto pela Efí fica pra depois).
  * `POST /api/pagamentos/:id/cobranca` (gera), `GET` (reabre o QR),
    `POST /api/webhooks/psp` (rota pública — marca a parcela paga quando o
    dinheiro entra e reflete no card do Kanban).
  * Front: botão "gerar cobrança" nas parcelas pendentes + modal com QR,
    copia-e-cola e link da fatura.
* **"Completar dados de cobrança" sob demanda.** Em vez de inchar o formulário
  do lead, quando falta CPF/endereço na hora de gerar a cobrança:
  * `leads`: colunas de endereço estruturado (`cep, logradouro, numero,
    complemento, bairro, cidade, uf`) — o boleto do PSP exige endereço; o Pix
    só o CPF. `endereco` (texto livre) segue populado como string de exibição.
  * `POST /api/leads/:id/dados-cobranca` valida o CPF (dígito verificador),
    formata o CEP e recompõe o `endereco` de exibição.
  * `POST /api/pagamentos/:id/cobranca` responde `422 DADOS_INCOMPLETOS` com a
    lista do que falta (`cpf` sempre; `cep/numero/logradouro/cidade/uf` só no
    boleto) antes de bater no PSP.
  * Front: o modal de cobrança troca pro formulário só com os campos que
    faltam — máscara de CPF, validação no cliente, CEP faz lookup no ViaCEP e
    preenche o resto. Salva no lead e volta a gerar a cobrança automaticamente.
  * Dados repassados ao PSP: Asaas recebe `postalCode/address/addressNumber/
    complement/province` no customer; Efí Pix só usa CPF + nome (o `/v2/cob`
    não aceita endereço no devedor).
* **Ações da linha num menu só.** Os botões soltos (cobrança / confirmar pago /
  estornar / excluir) viraram um **⋮** que abre um menu: "Gerar Pix / boleto",
  "Pagamento confirmado", "Estornar", "Excluir" — conforme o status e o papel.
* **Carnê do plano** — botão na linha-pai do parcelamento abre
  `GET /api/pagamentos/carne?ids=...`.
  * **Capa**: beneficiário + pagador (nome/CPF/endereço), resumo do plano
    (`Nx de R$ Y · forma`, 1º vencimento), **tabela** `Parcela | Vencimento |
    Valor | Situação` e **resumo** `Total · Pago · Saldo devedor`.
  * **Ficha por parcela** no layout de boleto: cabeçalho com logo + Vencimento e
    Valor (em vermelho), blocos **Beneficiário / Pagador** com barra de seção,
    **Detalhamento**, **Forma de pagamento** (valor final destacado),
    **Informações adicionais**, linha de corte "✂ pague aqui", e então o QR do
    Pix ou a linha digitável + link do boleto oficial.
  * Nº do documento por parcela (`REF-PP/NN`), datas de emissão e do documento,
    local de pagamento por método.
  * Botão **"⎙ esta folha"** por página (capa incluída); "Imprimir tudo" no topo.
  * Empresa vem de `crm_empresas` (`resolveEmpresaParaLead`). Sem dependência
    nova. A **ficha de compensação bancária + código de barras + nosso número**
    continuam vindo do PDF que a Efí/Asaas emite (link "Abrir boleto oficial").

## 2026-09-07 — Sincronia Kanban → Financeiro: confiável e reversível (Fase 1)

### Corrigido
* **O espelho `crm_pagamentos` só "subia" — nunca voltava.** Card saía de Ganho
  (ou perdia o `valor_recebido`) e a linha ficava `pago` pra sempre, com
  `pago_em` gravado, entrando no fluxo de caixa. Agora `syncLeadPagamento` faz a
  transição reversa `pago → pendente` (só nas linhas geridas pelo Kanban).
* **Sync não disparava em toda ação do card.** Só rodava ao *entrar* numa coluna
  de valor. Sair de Ganho/Agendado, **descartar** (`discard`) ou **encerrar
  atendimento** (`end-service`) deixavam pagamento fantasma. Agora dispara em
  qualquer mudança de coluna + nesses dois endpoints.
* **`pago_em` era a data do orçamento, não do recebimento** — receita caía no mês
  errado. Nova coluna `leads.data_pagamento`, carimbada na transição que torna o
  card pago; o espelho usa ela.
* **Corrida podia criar linha-espelho duplicada** (soma dobrava). Dedup-on-read
  + índice único parcial best-effort + mesclagem das duplicatas legadas no boot.

### Adicionado
* `crm_pagamentos.origem_sync` (`kanban` | `kanban-detached` | `manual`) —
  discrimina quem gerencia a linha. Só `kanban` é revertida pelo sync.
* `crm_sync_log` (ring ~800) + `logSyncPag` — trilha de "por que esse número
  mudou". Guard: valor > R$ 1M num lead aborta o sync e registra.
* Fila de retry (`_dirtyLeadPag` + worker de 25s, só `!VERCEL`).
* Descrição do espelho junta procedimentos (`"Botox + Preenchimento (+1)"`).

### Fora desta fase (de propósito)
* Back-sync Financeiro → Kanban; mover card por pagamento (trava do AGENTS.md);
  unificar métrica de receita (muda histórico — precisa de preview); backfill
  dos ganhos legados; regra "estorno manual zera o card".

## 2026-09-07 — Menu mobile: submenu "Campanhas"/"Relacionamento" não sai da tela

### Corrigido
* Os flyouts horizontais da sidebar ("Campanhas ›", "Relacionamento ›")
  abriam à direita do drawer e ficavam cortados fora da tela no celular. Em
  `≤768px` agora abrem como um painel **dentro do drawer**, logo abaixo do
  item, com largura = drawer − margem e scroll próprio se não couber.
  `openSidebarFlyout` ganhou o ramo mobile; o desktop segue igual.

## 2026-09-07 — Financeiro: sidebar sincronizada com o app

### Corrigido
* A `historico.html` tinha uma **cópia velha da sidebar**: faltava Fluxos e
  Mídias, "Campanhas" era um botão solto (sem o submenu Disparo / UTMs / ROI de
  Anúncios), "Relacionamento" usava a estrutura antiga de dropdown, e não tinha
  "Agente de IA". Agora o `<header>` é idêntico ao do `index.html`.
* Clicar num item do menu na tela Financeiro passava pra `index.html` e caía na
  view padrão — agora leva `?goto=<tab>` e abre a tela certa (`initApp` lê o
  parâmetro, no mesmo esquema do `?open_chat`).
* **Logo menor** na `historico.html` (`.sb-logo-full` 26px → 42px, igual ao
  principal) e o **botão "Agente de IA"** aparecia como um círculo preto liso —
  faltava o módulo `liquid-gradient.js` que anima o avatar `.lqa`. Adicionado.

## 2026-09-07 — Financeiro: estado vazio limpo

### Corrigido
* A aba "Agendamentos" mostrava, abaixo do "Nenhum agendamento encontrado",
  **15 linhas fantasma** (`--/--/----`, `R$ 0.00`, badge `-`) — parecia erro de
  carregamento. Agora é só a mensagem centralizada, com ícone e a dica "ajuste
  o período ou os filtros".

## 2026-09-07 — Kanban no celular: filtros colapsáveis

### Alterado
* Os ~7 filtros do Kanban empilhados ocupavam quase meia tela no celular antes
  de aparecer qualquer lead. Em `≤768px` a barra vira **busca + botão
  "Filtros"** — o resto (responsável, origem, ordenação, datas, "Apenas
  Agendados", "Limpar") só aparece ao tocar em Filtros, cada um em largura
  total. Puro CSS + um `classList.toggle('kf-open')` no botão.

## 2026-09-07 — Conversa em tela cheia no celular

### Alterado
* Com uma conversa aberta no celular, a **topbar global** (hambúrguer / tema /
  sino / conta) fica escondida — ela ficava empilhada, redundante, sobre o
  header do chat, comendo ~52px. O ← do header volta pra lista, onde a topbar
  reaparece (padrão de app de mensagem). Feito com
  `#main-content:has(#view-chat.chat-open) .topbar-user`.

## 2026-09-07 — Atendimento no celular: header e balões mais enxutos

### Alterado
* `@media (max-width: 480px)` no chat: header do chat com menos padding/gap,
  avatar do contato escondido (redundante logo depois da lista), nome/telefone
  menores, botões de ação (`.copilot-btn`) mais estreitos.
* Balões de mensagem passam de 75% → 86% da largura no celular (o padrão
  desperdiçava a tela); `#chat-active-messages` e composer com padding menor.
* "Fabricio Alves" no topo esconde o nome (só avatar) a partir de 500px em vez
  de 430px — deixa de disputar espaço com os ícones.
* **Composer**: a caixa de texto vazia parava de crescer 4 linhas com o
  placeholder longo — `autoExpandChatInput` agora trava em 44px quando não há
  texto. Coluna do textarea ganhou `min-width: 0` (encolhe direito no flex),
  placeholder encurtado, e no celular os ícones caem pra 34px com gaps menores
  pra sobrar largura pro campo.

## 2026-09-07 — Biblioteca de Mídia: sem vão à direita e no rodapé

### Alterado
* `.midx-wrap` agora é **centralizada** (`margin-inline: auto`) — o `max-width`
  de 1200px deixava um vão só do lado direito em telas largas.
* A grade de arquivos cresce pra preencher a altura da view (`flex: 1` +
  `overflow-y: auto`), então o espaço vazio fica **dentro** da caixa
  delimitada ("espaço pra mais arquivos") em vez de um vão preto embaixo.

## 2026-09-07 — Biblioteca de Mídia: menos vazio (Impeccable)

### Alterado
* `.midx-wrap` limitado a 1200px — as pastas param de ficar perdidas num
  painel de ~1900px.
* A grade de arquivos virou uma **área delimitada** (borda + fundo +
  `min-height: 340px`, `align-content: start`) — lê como "aqui ficam os
  arquivos / solte aqui" em vez de cards flutuando no vazio. A borda também
  acende no dragover.
* Tiles um pouco maiores (min 150px → 164px); pastas com mais respiro e nome
  em peso 600. O grid do modal de envio ignora a borda/min-height.

## 2026-09-07 — Follow-up automático: editor mais legível (Impeccable)

### Alterado
* **Layout de 2 colunas a partir de 1200px:** "Lembretes (em cascata)" ocupa a
  coluna principal e os blocos "Onde aplicar" / "Horário permitido" / "Ao
  esgotar" ficam ao lado, aproveitando o espaço que antes ficava vazio à
  direita. Abaixo disso, empilha em coluna única.
* "Ativo" virou o `.ui-switch` do sistema (mesmo toggle do Agente de IA).
* Campos `time` em "Horário permitido" lado a lado, sem espaço morto.
* Campos do editor (`#fx-editor`) param de esticar pra largura toda do painel —
  coluna de até 780px. `input[type=number]` (minutos) e `input[type=time]`
  ganharam largura máxima em vez de ocupar a linha inteira.
* Card de lembrete: o texto "4 h após a última mensagem" saiu do estilo
  minúsculo/apagado (`.fx-mini`) pra legível (`.fx-node-when`) — é a info
  principal do card. Conector vertical entre lembretes reforça a cascata.
* Corpo do card com mais respiro entre campos; anel de foco visível; `aria-label`
  no botão de remover lembrete.

## 2026-09-07 — Dashboard: itens P2 restantes do audit (mobile, teclado, toque)

### Corrigido
* **Funil reflui no mobile:** abaixo de 560px de largura do container, a forma
  orgânica com rótulos posicionados por % (que se sobrepunham) dá lugar a
  barras horizontais empilhadas — uma por etapa, largura proporcional.
* **"Personalizar" agora é operável por teclado:** cada card ganhou botões
  mover ◀/▶ e estreitar/alargar nas ferramentas (`moveDashboardCard` /
  `resizeDashboardCard`), reaproveitando a mesma lógica do arraste + resize por
  ponteiro. O grip de arraste virou `aria-hidden`.
* **Alvos de toque** dos presets de período, do seletor de datas e de
  "Personalizar" subiram pra `min-height: 40px`; botões das ferramentas do card
  22px → 26px, toolbar com `flex-wrap`.

## 2026-09-07 — Dashboard: correções do audit Impeccable (a11y, tema, perf)

### Corrigido
* **Gráficos `<canvas>` + funil SVG** agora expõem `role="img"` + `aria-label`
  com o resumo dos dados — antes eram invisíveis pra leitor de tela (WCAG 1.1.1).
* **Chart.js lia cor fixa de tema escuro:** `leadsChart` usava `#38bdf8`,
  `rgba(255,255,255,0.5)` (ticks) e `rgba(255,255,255,0.05)` (grade) direto —
  no tema claro os eixos sumiam. Agora lê `--accent-primary` e as cores de
  texto/grade já calculadas por tema. `toggleTheme` re-renderiza o dashboard se
  estiver aberto (Chart.js fixa as cores na criação).
* **Botão de período ativo** era texto branco sobre `--accent-primary` (2.1:1,
  falha AA). Virou fundo `--bg-hover` + sublinhado `--accent-primary`, igual ao
  segmented control do ROI.
* **Hierarquia de heading:** "Meta de Receita" era `<h3>` logo após o `<h1>` —
  virou `<h2>`. Emoji do título com `aria-hidden`.
* **Poll de 60s** deixou de re-animar os 3 gráficos a cada ciclo
  (`window._dashSilentRender` → `animation: false` no Chart.js).
* Pílula de % do funil (`#fff`/`#000` fixos) e ícone da meta (`#60a5fa`) →
  tokens. `chart.js` do CDN pinado em `@4` (era `latest`).

## 2026-09-07 — Ficha do lead: aproveita a largura, menos scroll (Impeccable)

### Alterado
* **`#lead-profile-panel`** deixou de ser uma coluna estreita (820px) centrada
  numa tela larga com metros de vazio dos lados:
  * conteúdo até 1060px; **Origem + Informações lado a lado** (grid 2 col a
    partir de 880px), separador único sob o par em vez de um por card.
  * `padding` das seções 1.75rem → 1.25rem e do header 3rem → 2rem — cabe tudo
    com bem menos rolagem.
* **"ID do Clique Meta"** (ctwa_clid, ~100 chars) parava de quebrar em 2 linhas
  num bloco monospace: agora trunca com reticências (`title` mostra inteiro) +
  botão de copiar (`lppCopyText`).

## 2026-09-07 — Base de Contatos: densidade e larguras (Impeccable, modo Operate)

### Alterado
* **Tabela da Base de Contatos** (`#view-contatos`, scoped — não mexe no
  `.crm-table` compartilhado das outras telas de relacionamento):
  * `table-layout: fixed` + `<colgroup>` com larguras fixas nas colunas de dados
    — acaba com a coluna "Contato" ocupando ~metade da tela e o resto espremido.
  * Linhas mais densas (padding 1rem → 0.6rem) e cabeçalho 0.72rem maiúsculo;
    cabem mais contatos na tela.
  * Nome com avatar de **inicial** (letra) em vez de ícone genérico; trunca com
    reticências (title no hover mostra o nome inteiro). Origem também trunca.
  * "Msgs" alinhado à direita e em linha (`3 · 1 recebida`, singular correto).
  * Ação "Abrir conversa" (pílula verde 100% da largura em toda linha) virou um
    botão discreto "Abrir" com contorno, verde só no hover.
  * `font-variant-numeric: tabular-nums`, hover de linha via `--bg-hover`, anel
    de foco `--accent-primary`.

## 2026-09-07 — Meta Marketing API: gasto de anúncio + ROI por campanha (Fase 1)

### Adicionado
* **Integração com a Meta Marketing API** (complementa a CAPI, que já mandava
  conversão *pro* Meta — agora a gente puxa *do* Meta quanto cada campanha
  gastou). Single-tenant: conta e token vêm do `.env`.
  * **`syncMetaMarketing({ days })`**: puxa campanhas, anúncios (com criativo,
    que passa a alimentar o contexto de anúncio da IA) e insights diários por
    anúncio (`spend`, `impressions`, `clicks`, `reach`, conversas iniciadas,
    leads de formulário). Grava em 3 tabelas novas no D1: `ad_campaigns`,
    `ad_ads`, `ad_insights_daily` (PK `(date, ad_id)`, upsert via
    `INSERT OR REPLACE`, inserts em lote pra poupar cota do D1).
  * **`marketingSyncTick()`**: roda dentro do `/api/flow-tick` com cadência
    própria — só busca de verdade a cada `MARKETING_SYNC_HORAS` (default 6).
  * **`GET /api/marketing/status`** — o que está configurado e quando rodou o
    último sync.
  * **`POST /api/marketing/sync?days=N`** (admin) — dispara o sync na hora;
    `?days=30` pra backfill.
  * **`GET /api/marketing/roi?since=&until=`** — cruza gasto por campanha com os
    leads atribuídos (`ad_referral.source_id` → `ad_ads.campaign_id`, gravado
    pelo webhook de Click-to-WhatsApp) e o estágio do Kanban: devolve leads,
    qualificados, consultas (`col-agendado`/`col-ganho`), ganhos, receita e os
    derivados custo por lead / por qualificado / por consulta / por ganho e
    ROAS. Lead de anúncio sem `source_id` casável cai no balde "não atribuído a
    campanha". Janela default: últimos 30 dias.
* **`.env`**: `META_ADS_ACCOUNT_ID` (obrigatório), `META_ADS_TOKEN` (opcional —
  cai pra `META_API_MARKETING` e depois `META_ACCESS_TOKEN`),
  `MARKETING_SYNC_HORAS`.
* `appsecret_proof` (HMAC do token com `META_APP_SECRET`) é anexado às chamadas
  do Graph quando o segredo está no ambiente.
* **Tela "ROI de Anúncios"** no menu Campanhas (`switchTab('marketing')` →
  `#view-marketing`): tabela por campanha com custo por lead / qualificado /
  consulta e ROAS (verde ≥ 1×, vermelho < 1×). Botão "Sincronizar" (só admin)
  chama `POST /api/marketing/sync?days=30`. Estados de "não configurado" e "sem
  dados no período" tratados. Funções em `app.js`: `loadMarketingView` /
  `renderMarketingRoi` / `marketingSyncNow`.
* **Coluna "Conversas"** na tabela de ROI: conversas de WhatsApp iniciadas pelo
  anúncio (`msg_started`, número do Meta), entre Gasto e Leads. A diferença pra
  Leads mostra perda de atribuição no CRM. `totais.msg_started` agregado no
  `/api/marketing/roi`; `<th>` da tabela aceita `hint` → `title`.
* **`getAdContextForPhone`** passou a usar o criativo completo do anúncio
  (`ad_ads.creative_body`, sincronizado pela Marketing API) quando o
  `referral.source_id` casa — cai pro trecho do webhook se o sync nunca rodou.
* **Controles de período reformulados:** presets viraram um segmented control
  (ativo com fundo `--bg-hover` + sublinhado `--accent-primary`, sem branco
  sobre azul); as duas `input[type=date]` viraram um campo único que abre o
  AirDatepicker em modo range (`dd/MM/yyyy`), no mesmo padrão do Dashboard, com
  botão ✕ pra voltar ao preset. Estado em `window._mktRange` (`{since, until,
  preset}`). Toolbar agrupada: período · datas · ações.
* **Passe de acabamento (Impeccable, modo Operate):** a faixa de 6 KPI-cards
  virou um resumo em linha única com "custo por consulta" como número de
  decisão (hierarquia, não 6 caixas iguais). Presets de período 30d / 90d / 1
  ano espelhando o Dashboard. Ordenação por clique em qualquer coluna (seta só
  na coluna ativa / no hover). Numerais tabulares na tabela e no resumo. Foco
  visível com anel `--accent-primary`. Cores semânticas via tokens
  (`--accent-success` / `--accent-danger`), hover de linha via `--bg-hover`,
  sem `color-mix`. Divisória de 1px separando o grupo "eficiência". Barra de
  participação no gasto reduzida a 2px e só quando há gasto.

## 2026-09-05 — Botão "Finalizar atendimento" no chat

### Adicionado
* **Botão vermelho "Finalizar atendimento"** no cabeçalho do chat, ao lado de
  "Ferramentas". Para leads que não são oportunidade real (número errado, de
  outro estado, spam). Numa ação só, via `POST /api/leads/:id/discard`:
  * desliga a IA desse lead e desatribui o atendente;
  * `campaign_opt_out = 1` — para de entrar em campanha;
  * para os follow-ups em andamento (por `lead_id` e por telefone) e encerra
    fluxos ativos;
  * **bloqueia o número** (todas as variantes) em `crm_chat_settings` — o
    webhook passa a ignorar mensagens novas dele, então não cria lead de novo
    nem a IA responde;
  * move pra "Follow Up/Perdido" com a etiqueta `descartado` e carimba a nota.
  Reversível: desbloquear o número, tirar o opt-out e mover o lead de volta.
* Confirmação antes de executar (`customConfirm`).

### Alterado
* **`followupTick` Estágio A** deixou de abrir follow-up para leads com
  `campaign_opt_out = 1` (antes abria a execução e só o Estágio B a matava no
  tick seguinte).

## 2026-09-05 — Corta o rows_read do D1 (lista de conversas era ~65% da cota)

### Alterado
* **Diagnóstico:** o painel do D1 mostrou que **uma consulta** — a lista de
  conversas (`GET /api/whatsapp/chats`: `GROUP BY` na `wa_messages` inteira +
  3 subconsultas por conversa, sem filtro) — respondia por **~2,8M das ~4,3M
  linhas lidas por dia** (~65%), porque o polling de cada aba a chamava ~1x/min.
* **Snapshot cacheado no próprio D1** (`crm_settings.wa_chats_cache`, JSON com
  `built_at` + `rows`, TTL de 5 min). Vale entre as instâncias serverless da
  Vercel. `built_at` velho → reconstrói 1x e regrava. Consulta ganhou
  `LIMIT 500` (blob de ~34 KB hoje, teto do D1 é 1 MB). A consulta cara passa a
  rodar **~1x a cada 5 min** em vez de ~1x/min.
* **Mensagem nova não refaz a consulta.** O evento SSE `wa_message` agora
  carrega telefone + prévia + hora; o front **remenda a lista localmente**
  (`patchChatListFromSSE`: move pro topo, atualiza prévia, incrementa não-lidas,
  cria a linha se for número novo) e toca o som. A reconciliação com o servidor
  fica pro poll de rede de segurança.
* **Polling da lista: ~36s/18s → ~90s** (`app.js` e `wa_chat_logic.js`). Agora
  que o SSE entrega o tempo real, o poll é só backup — e quase toda chamada
  cai no cache (lê ~1 linha).
* **Índice** `idx_followup_lead` em `crm_followup_runs(lead_id, status)` — a
  consulta por `lead_id` lia ~42 linhas pra devolver 1.

Estimativa: aquela consulta cai de ~2,8M linhas/dia para ~500 mil.

## 2026-09-05 — Detector de oportunidades no WhatsApp (IA, custo mínimo)

### Adicionado
* **Ferramenta que varre as conversas algumas vezes por dia e sinaliza leads
  "quentes" que estão esperando retorno e demonstraram intenção de compra**
  (perguntou preço, quis agendar, pediu horário). É passiva — nunca manda
  mensagem; cria uma **notificação clicável** no sino ("Abrir conversa →") e
  põe a etiqueta **💰 Oportunidade** no lead (filtrável no Kanban).
* **Funil de 3 camadas pra o custo de `rows_read` do D1 ficar desprezível**
  (medido: ~100–300 linhas lidas por rodada, contra a cota de 5M/dia):
  1. Peneira SQL barata em `leads` (`last_msg_direction='in'` + janela de data
     + colunas ativas) — 1 consulta, ~60 linhas. Índice novo
     `idx_leads_lastmsg`.
  2. Palavra-chave (regex configurável) na última fala do lead — em memória,
     sem IA. Só quem passa vai adiante.
  3. **Uma** chamada `gemini-3.6-flash` (reaproveita `callGeminiCopilot`) com o
     lote inteiro, pedindo JSON `{oportunidade, motivo, proximo_passo}` por
     conversa. ~2–3 chamadas/dia.
* **Cadência própria por dentro:** roda a varredura cara no máximo 1x a cada
  `intervalo_horas` (padrão 8, config) e só em horário comercial — então é
  chamada de dentro do `/api/flow-tick` (que já roda periódico) sem custo
  extra. Dedupe por id de notificação determinístico
  (`opp-<leadId>-<last_msg_at>`): não re-sinaliza a mesma mensagem; se o lead
  mandar algo novo, volta a ser elegível.
* **Endpoints:** `GET/PUT /api/opps/config` (admin), `POST /api/opps/run`
  (admin, "rodar agora" com cooldown de 1h).
* **UI:** seção "Detector de oportunidades" no modal "Agente de IA" — liga/
  desliga, intervalo, lista de palavras-chave e botão "Rodar agora" com o
  resumo da última varredura.

## 2026-09-05 — followupTick Estágio B: blindado contra reenvio e enxurrada

### Alterado
* **O run avança de etapa ANTES do envio** (era depois). Se a função serverless
  fosse morta por timeout entre o envio e o `UPDATE`, o run continuava
  `agendado` com a mesma etapa e vencido — e o próximo tick **reenviava** a
  mesma mensagem. Agora, se algo morrer entre o `UPDATE` e o envio, a etapa é
  **pulada** (nunca reenviada). O código já engolia erro de envio e avançava
  do mesmo jeito, então isso só deixa o comportamento consistente também no
  caso de timeout — um follow-up perdido é bem melhor que um duplicado.
* **Orçamento de tempo no Estágio B:** se o lote demorar mais de ~35s, para com
  folga antes do timeout da Vercel. O que sobrar fica `agendado`/vencido e é
  processado no próximo tick, sem perder nem duplicar.
* **Folga de 150 ms entre envios**, pra não empilhar o lote inteiro no mesmo
  instante (não é limite da Meta — é só cadência).
* O teto de `max_por_tick` (config = 25) já limitava o lote por tick; nada disso
  muda com o cron passando a rodar a cada 30 min — só faz uma fila acumulada
  (ex.: a das ~17h que ficou parado) escoar mais devagar, 25 por tick.

## 2026-09-05 — followupTick fazia ~800 consultas D1 por tick (Estágio A em lote)

### Alterado
* **`followupTick` (Estágio A — abrir follow-ups novos) passou a consultar em
  lote.** Antes, pra cada lead candidato (até 200 por tick) fazia ~4 consultas
  separadas ao D1 — "já tem run?", "mesma âncora?", "fluxo esperando?", "última
  mensagem recebida?" — mesmo quando o lead já ia ser descartado. Como o cron
  (`/api/flow-tick`) roda a cada poucos minutos, isso sozinho era um dreno
  grande de `rows_read` do D1 (a mesma cota que a gente já mexeu no polling do
  chat). Agora: os filtros que não dependem de banco rodam em memória primeiro,
  e as 3 consultas restantes são feitas UMA vez por bloco de 15 leads
  (`... WHERE lead_id IN (...)` / `phone IN (...)`), não por lead. Mesmo
  comportamento e mesmas contagens de debug, com ~1 consulta pra cada 40 de
  antes. Estágio B (processar os agendados que já venceram) não mudou — ele já
  é limitado por `max_por_tick` e só roda quando há algo realmente vencido.

### Corrigido
* **`playNotificationSound()` criava um `AudioContext` novo a cada mensagem
  nova.** Todo `AudioContext` nasce "suspended" pela política de autoplay do
  navegador e só toca de verdade depois de um gesto do usuário (clique,
  tecla, toque) na página — antes disso funcionava porque quase sempre havia
  algum gesto por perto. Agora que mensagem nova chega também via SSE em
  segundo plano (sem clique nenhum no momento), o som ficava mudo,
  silenciosamente, só com o aviso "AudioContext foi impedido de iniciar
  automaticamente" no console. Corrigido reaproveitando um único
  `AudioContext` (em vez de criar um novo a cada som), destravado com
  `.resume()` no primeiro clique/tecla/toque da sessão — depois disso
  continua tocando mesmo quando chamado sem gesto nenhum.

## 2026-09-05 — IA parava depois do 1º balão de respostas partidas em vários pedaços

### Corrigido
* **A IA mandava só o primeiro balão de uma resposta com vários balões, e
  parava.** Bug introduzido pela própria checagem anti-duplicidade desta
  sessão: `hasOutboundSince` (usada por `sendWhatsappAiReplyHuman` antes de
  cada balão, pra abortar se "alguém já respondeu depois do gatilho") não
  distinguia a mensagem de outra pessoa da mensagem que a PRÓPRIA IA
  acabou de mandar um instante antes (o balão 1 da mesma resposta). Assim
  que o balão 1 saía, o balão 2 via aquele envio como "já responderam" e
  desistia — a conversa parava sempre no primeiro pedaço. Corrigido
  filtrando `sent_by != 'ia'` nessa checagem: continua pegando um atendente
  humano (ou um fluxo) assumindo a conversa no meio do envio, só para de se
  confundir com os próprios balões.

## 2026-09-05 — Mensagem nova do WhatsApp avisa na hora (SSE), mesmo com a aba em segundo plano

### Adicionado
* **Chat deixa de depender só de polling pra saber que chegou mensagem nova.**
  O código pausa de propósito TODO o polling (lista de chats, dashboard,
  notificações) quando a aba fica em segundo plano — dá pra economizar cota
  do D1, mas isso fazia a chegada de mensagem parecer travada até o atendente
  voltar pra aba ou clicar no card da conversa. A conexão SSE do Kanban
  (`/api/kanban/events`) não está nessa lista de pausa e continua viva com a
  aba oculta. Agora o webhook do WhatsApp manda um evento `wa_message` nela
  assim que salva a mensagem recebida (antes mesmo do agente de IA rodar, que
  pode levar vários segundos) — o front atualiza a lista de conversas (badge,
  som, ordem) e, se for a conversa que já está aberta, atualiza ela também,
  na hora, em qualquer aba conectada.

## 2026-09-05 — Agente de IA: coalesce respostas duplicadas + "Hoje" no Kanban

### Corrigido
* **IA mandando duas respostas completas pro mesmo lead** (ex.: duas saudações
  "Oi, sou a Nati..." seguidas, quase iguais): quando o lead manda uma rajada
  de mensagens, a Meta dispara um webhook por mensagem e cada um chamava
  `handleWhatsappAiAutoReply` em paralelo, sem nenhuma checagem entre eles —
  cada invocação gerava e enviava a própria resposta. Agora a função recebe a
  mensagem-gatilho (`incomingWamid` + timestamp) e, em três pontos (antes de
  chamar o Gemini, logo depois, e dentro de `sendWhatsappAiReplyHuman` antes de
  cada balão), confere se ainda é a última mensagem do lead e se ninguém já
  respondeu depois dela — se não for, desiste e deixa a invocação da mensagem
  mais nova responder com a conversa inteira no contexto. Não foi somado
  nenhum atraso novo: as checagens reaproveitam a latência que já existia
  (chamada ao Gemini + pausas de ritmo humano) pra não arriscar estourar o
  timeout do webhook da Meta.
* **Card do Kanban mostrando "1d atrás" pra lead criado hoje:** o cálculo de
  `daysSince` usava `Math.ceil` + `Math.abs`, então qualquer diferença maior
  que zero (mesmo segundos) virava 1 dia inteiro. Agora é `Math.floor` e
  mostra "Hoje" quando dá zero ou negativo. (A causa de fuso horário nesse
  mesmo cálculo já tinha sido corrigida antes, em `fb2bf1e`.)

## 2026-09-04 — Reduz polling pra economizar cota de leitura do D1

### Alterado
* **Cloudflare D1 estava a 76% da cota diária grátis de rows_read.** Sem mudar nenhuma lógica, só espaçou os intervalos de atualização automática (a atualização em tempo real via SSE e o refresh da conversa aberta continuam rápidos):
  * `kanbanSyncInterval` (fallback do SSE do Kanban): 30s → 90s.
  * `globalChatCheckInterval` (lista de conversas em segundo plano): 20s → 45s.
  * `chatPollingInterval` — cadência do `loadChats` (a consulta cara, `GROUP BY` + subquery por conversa): ~18s → ~36s. A conversa aberta continua atualizando a cada 6s (barata, filtra por telefone).
  * `dashPollingInterval` (auto-refresh do dashboard): 30s → 60s.

## 2026-09-03 — Anti-duplicidade no envio, filtro "Aguardando resposta" e ordenação padrão

### Adicionado
* **Trava anti-duplicidade no envio manual:** não deixa mandar a mesma mensagem de texto 2x sem querer (Enter batido duas vezes, clique duplo, reenvio por lag).
  * Front (`wa_chat_logic.js`): `chatSendInFlight` bloqueia envio concorrente; se a mesma mensagem foi enviada pro mesmo número há menos de 15s, pede confirmação antes de repetir.
  * Back (`api-server.js`): `/api/whatsapp/send` responde `409` se já existe uma mensagem `out` idêntica pro mesmo número nos últimos 15s; o front oferece reenviar com `force: true`.

### Alterado
* **Filtro "Aguardando resposta" (chat):** estava invertido — mostrava as conversas em que *nós* mandamos a última mensagem. Agora mostra as conversas em que **o lead** mandou a última e ninguém (atendente ou IA) respondeu, igual à etiqueta ⏳ do card.
* **Filtro "Qualificados aguardando" removido:** virou redundante — era só o "Aguardando resposta" restrito aos leads com a tag `ia-qualificado`. A tag e o mecanismo de handoff da IA continuam iguais.
* **Modal "Enviar Template" agora lista os templates aprovados:** era um campo de texto onde a pessoa tinha que digitar o nome exato do template. Vira um `<select>` carregado ao vivo de `/api/whatsapp/templates` (só os `APPROVED`), com prévia do corpo. O idioma vai **exatamente o que a Meta registrou** pro template (o `<select>` de idioma causava `#132001`). Templates com cabeçalho de mídia, variável no cabeçalho, botão dinâmico ou 2+ variáveis no corpo aparecem como "(⚠ não suportado)" e são barrados com mensagem clara antes de gerar `#132000`. Corpo com 1 variável é preenchido com o nome do paciente.
* **Balão de template no chat mostra a mensagem real:** antes aparecia só "📋 Template enviado: *nome*". Agora grava o texto do template (cabeçalho de texto + corpo com variáveis preenchidas + rodapé), então dá pra ler o que foi enviado. Cabeçalho de mídia aparece como `[image]`/`[video]`/`[document]`.

### Corrigido
* **Lista de conversas com `direction`/`message`/`status` errados:** `/api/whatsapp/chats` dependia do "bare column + MAX()" do SQLite, que o D1 não garante — a `direction` podia vir de qualquer mensagem da conversa, não da última. Isso jogava conversas com a última mensagem nossa dentro do filtro "Aguardando resposta". Agora usa subquery explícita pela última mensagem (timestamp, e rowid no empate).
* **Ordenação padrão do Kanban:** de "Mais antigos primeiro" para **"Mais recentes primeiro"** (`created_desc`). Quem já escolheu uma ordenação mantém a dela.
* **Filtro de origem do Kanban ("Meta Ads"):** era comparação exata, mas lead de anúncio é salvo como `"Meta Ads: <título do anúncio>"` — então o filtro não retornava nada. Agora casa por prefixo.

## 2026-09-03 — Retry do 9º dígito no envio de WhatsApp (erro 131026)

### Corrigido
* **Mensagens "Message undeliverable" (131026) para números do Brasil:** o `wa_id` que a Meta manda no webhook nem sempre é a forma que a Cloud API aceita para **envio** (inconsistência histórica do nono dígito). Agora, ao receber `131026`, o servidor repete o envio **uma vez alternando o 9º dígito** (com ⇄ sem). Se a forma alternativa funcionar, o histórico do chat (`wa_messages.phone`) e o telefone do lead são migrados para ela — os próximos envios vão direto.
* **`api-server.js`:** novas funções `toggleBR9()`, `postMetaMessage()` (POST + retry) e `migrateChatPhone()`. Aplicadas em `/api/whatsapp/send` e nos envios internos (`sendWhatsappTextInternal`, `sendWhatsappTemplateInternal`, `sendWhatsappAudioInternal`). Passou a usar `contacts[0].wa_id` da resposta como forma canônica do número.
* **Lead com número inválido:** se o `131026` persiste nas duas formas do 9º dígito, o lead ganha a etiqueta `numero-invalido` para alguém buscar o número correto.

## 2026-09-03 — Follow-up automático fora da janela de 24h (via template)

### Alterado
* **Follow-up automático (Fase 2):** quando um lembrete cai fora da janela de 24h do WhatsApp, em vez de ser pulado, agora envia um **template aprovado da Meta** configurado no próprio passo. Dentro das 24h continua indo o texto livre.
* **`api-server.js`:** novas funções internas `getWhatsappTemplateMeta()` (busca + cache de 5 min do idioma/variáveis do template na Graph API) e `sendWhatsappTemplateInternal()` (envio de template pelo caminho interno, registra em `wa_messages` / `wa_template_sends` e atualiza `leads.last_msg_at`). `followupTick()` passa a chamá-la no lugar de descartar o passo. Suporta templates com 0 ou 1 variável de corpo (preenchida com o nome do paciente).
* **`flows.js`:** o editor de follow-up carrega os templates aprovados e mostra um seletor "Fora da janela de 24h, enviar template" em cada lembrete. Avisa quando o template salvo não está mais entre os aprovados ou tem 2+ variáveis.

## 2026-08-22 — Correções e Melhorias no Fluxo de Mídia e Respostas do WhatsApp

### Alterado
* **Envio de Mídia no WhatsApp:** Reescreveu o endpoint `/api/whatsapp/send` para suportar nativamente o upload e envio de imagens, áudio, vídeo e documentos para a API do WhatsApp (Meta Developers), interceptando os payloads Base64 vindos do frontend e convertendo-os em uploads reais.
* **Recebimento de Mídias:** Adicionou tratamento no webhook (`POST /api/whatsapp/webhook`) para decodificar e processar novos tipos de mídias recebidas (`image`, `audio`, `voice`, `video`, `document`) e salvar referências seguras para lazy-loading.
* **Proxy de Mídias:** Criou rota segura `/api/whatsapp/media/:mediaFile` para realizar o download e streaming sob demanda das mídias direto dos servidores da Meta para o navegador, sem persistir arquivos binários no banco D1 local, contornando o limite de query de 1MB do banco Cloudflare D1.
* **Suporte de Tipos Adicionais:** Adicionou tratamento para mensagens do tipo `sticker`, `reaction`, `location` e `contacts` no webhook para evitar logs de tipo `unsupported`.
* **Exibição de Respostas (Quotes):** Implementou exibição gráfica de respostas a mensagens (mencionar mensagens) no CRM similar ao layout do WhatsApp (borda colorida indicando o remetente, visualização inline e miniatura em miniatividade para imagens/vídeos).
* **Interatividade de Respostas:** Adicionou a funcionalidade de clique nas mensagens respondidas, rolando a tela suavemente (`scrollIntoView`) e destacando (efeito flash luminoso e pulso de escala) a mensagem original.
* **Funcionalidade de Responder Mensagens:** Adicionado suporte para enviar respostas a mensagens específicas diretamente do CRM (ao clicar no botão de responder em qualquer balão de mensagem, exibe um painel de visualização acima do campo de entrada e anexa o `quoted_id` na requisição de envio, persistindo a resposta com quote em tempo real).
* **Dropdown de Ações da Mensagem (Hover):** Implementou um menu global flutuante acionado ao passar o mouse sobre os balões de mensagem e clicar no chevron dropdown. O menu agrupa uma barra de reações rápidas (emojis) e opções verticais para "Responder", "Encaminhar", "Apagar" e "Baixar Mídia".
* **Agregação e Visualização de Reações:** Adicionado sistema de agrupamento no carregamento de conversas para exibir emojis de reação em formato de badge flutuante no canto inferior de cada balão de mensagem.
* **Lógica de Encaminhamento:** Desenvolvido modal de encaminhamento rápido de mensagens e mídias para qualquer lead existente sem necessidade de re-upload de arquivos no backend.
* **Exclusão de Mensagens:** Alterada a lógica do endpoint `/api/whatsapp/delete-message` e do frontend para não remover permanentemente a mensagem do banco, mas sim atualizá-la e exibi-la como "🚫 Esta mensagem foi apagada" em itálico e com opacidade reduzida, ocultando também o menu de ações adicionais sobre ela (semelhante ao WhatsApp).
* **Modais de Confirmação Customizados:** Substituídos todos os alertas de confirmação nativos do navegador (`window.confirm`) nas interações do chat por chamadas assíncronas ao `customConfirm`, exibindo caixas de diálogo estilizadas de acordo com o tema escuro do CRM da clínica.
* **Melhoria Visual do Pipeline (Tema Escuro):** Adaptação completa da UI escura do Kanban para o contexto sofisticado de uma clínica de estética. Implementou nova paleta de cores premium (fundo `#0F1115`, cards `#171A20`, hover destacados `#1C2027`, bordas `#292E36`), indicadores sutis de borda superior baseados na etapa, estados vazios descritivos com ícones e estatísticas de faturamento/pacientes por coluna.
* **Edição Rápida de Orçamento:** Adicionado botão de ação rápida de Orçamento (`.orc-btn`) representado por um ícone de documento e cifrão nos cards de pacientes que já estão na etapa "Orçado" ou possuem um orçamento ativo. O botão abre diretamente o modal com os dados preenchidos para edição imediata.
* **Agrupamento de Ações do Card (Três Pontos):** Consolidou as ações individuais flutuantes do card (WhatsApp, Ficha/Notas, Orçamento e Excluir) em um único botão de reticências verticais (`fa-ellipsis-vertical`) no canto superior direito do card. Ao clicar, exibe um menu de contexto flutuante moderno de acordo com o design premium do app, resolvendo o acúmulo de ícones na tela do Kanban.
* **Correção no Autocomplete de Orçamentos:** Corrigido o mapeamento do datalist de procedimentos do orçamento (`orc-procedimentos-amigo`), que estava incorretamente exibindo o rótulo "Amigo App" em vez do nome do procedimento real.
* **Melhorias no Fluxo de Login:**
  * **Tratamento de Espaços e Sensibilidade de Caixa:** O login no backend e frontend foi atualizado para remover automaticamente espaços em branco extras (através de `.trim()`) e ignorar letras maiúsculas/minúsculas no nome do usuário (através de `.toLowerCase()`), resolvendo falhas comuns de digitação/copiar-colar.
  * **Login com Tecla Enter:** Adicionado evento `onkeyup` nos inputs de Usuário e Senha para que pressionar a tecla `Enter` execute a autenticação imediatamente, sem obrigar o clique manual no botão "Entrar".
  * **Resolução de Erro de Sintaxe:** Corrigido um fechamento de chaves desalinhado no loop de disparos de campanhas em `app.js` que gerava um erro de compilação silencioso no navegador (`performLogin is not defined`).
* **Tamanho de Payload do Servidor:** Aumentou o limite de parse de corpo de requisições JSON e URL-encoded do Express para `50mb` em `api-server.js` para possibilitar o recebimento de arquivos de mídia Base64 maiores enviados pelo frontend.
* **Melhorias no Histórico de Agendamentos (Histórico Web):**
  * **Correção de Filtro de Data:** Resolvido bug em `historico.html` que impedia o filtro de data de funcionar devido a timestamps contendo horas no banco de dados. Agora a comparação extrai e valida apenas a data (`YYYY-MM-DD`).
  * **Formatação de Data e Hora:** Ajustada a exibição das datas na tabela do histórico financeiro para o formato brasileiro legível (`DD/MM/YYYY às HH:MM`).
  * **Status de Pagamento Interativo:** Substituída a tag estática por um `<select>` que possibilita a alteração imediata do status de pagamento diretamente de cada linha.
  * **Novo Endpoint PATCH:** Criada a rota `/api/historico-financeiro/:id/status` no backend em `api-server.js` para persistir as atualizações de status.
  * **Sincronização em Cascata (lead_id):** Adicionada a coluna `lead_id` à tabela `agendamentos_financeiro` do banco de dados D1. Alterações efetuadas no nome ou orçamento de um lead no Kanban agora são propagadas automaticamente para seus agendamentos correspondentes no histórico.
  * **Limpeza de Rotas Duplicadas:** Removida a declaração duplicada/morta da rota POST `/api/agendar` em `api-server.js`.

### Arquivos modificados
* [`api-server.js`](file:///c:/Users/USER-PC/Desktop/Sistema_Clinica_CRM/api-server.js)
* [`wa_chat_logic.js`](file:///c:/Users/USER-PC/Desktop/Sistema_Clinica_CRM/wa_chat_logic.js)
* [`historico.html`](file:///c:/Users/USER-PC/Desktop/Sistema_Clinica_CRM/historico.html)
* [`app.js`](file:///c:/Users/USER-PC/Desktop/Sistema_Clinica_CRM/app.js)
* [`index.html`](file:///c:/Users/USER-PC/Desktop/Sistema_Clinica_CRM/index.html)
* [`style.css`](file:///c:/Users/USER-PC/Desktop/Sistema_Clinica_CRM/style.css)

### Impacto
* Estabilização completa das mídias enviadas e recebidas pelo chat do WhatsApp no CRM.
* Interface mais interativa e alinhada à experiência real de troca de mensagens do WhatsApp Web.
* Prevenção de travamento no banco de dados Cloudflare D1 ao gerenciar arquivos grandes.

### Testes
* Executado script de teste automatizado simulando o upload de imagem de 1 pixel e envio do webhook.
* Validado ping do servidor local de desenvolvimento na porta 3000.
* Confirmado que o fluxo de mensagens de texto regulares e deletar mensagens permanece intacto.

### Observações
* O cliente deve executar um Hard Refresh (Ctrl + F5) no navegador após as modificações para limpar o cache do arquivo estático de scripts do chat (`wa_chat_logic.js`).

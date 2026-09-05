# Changelog - CRM Natuclinic

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

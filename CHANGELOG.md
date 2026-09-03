# Changelog - CRM Natuclinic

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

# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Atendentes comerciais da Natuclinic, no computador, durante o expediente. Passam o dia respondendo pacientes e leads no Atendimento (WhatsApp) e movendo leads no CRM Vendas (Kanban). O dono/gestor também entra para ver Dashboard, Financeiro, Campanhas e o briefing, mas o uso principal é o atendimento no desktop.

## Product Purpose

CRM interno da Natuclinic, clínica de estética e nutrição ortomolecular em Brasília/Taguatinga. Junta num lugar só a conversa com o paciente pelo WhatsApp, o funil de vendas, a agenda, o relacionamento pós-venda e os números de marketing. Sucesso é nenhum lead ficar sem resposta, cada lead andar no funil até virar consulta, e a equipe saber o que fazer agora sem caçar informação.

## Positioning

Feito sob medida para a operação da própria Natuclinic: o WhatsApp oficial da clínica, os anúncios da Meta, a agenda do Amigo e as automações de follow-up estão ligados direto ao funil, em vez de serem ferramentas separadas.

## Operating Context

- Atendimento: lista de conversas do WhatsApp Cloud API, conversa aberta, ficha do lead, trava de atendimento por atendente, presença de quem está vendo cada conversa, modos Humano / Robô (IA).
- CRM Vendas: Kanban de leads por etapa (funis renomeáveis), automações de etapa, ordenação "precisa de atenção".
- Agenda Completa, Contatos, Dashboard, Fluxos (automações), Mídias, Segundo Cérebro, Campanhas (disparo, origem dos leads, marketing), Relacionamento (aniversariantes, pós-venda, sumidos, faltantes), Equipe, Financeiro, Agente de IA, Configurações.
- Painel de Personalização (só admin): cores, fundo, fonte, tamanho e cantos, por modo escuro e claro. O tema salvo fica em `crm_settings.ui_theme`.
- Modo escuro é o principal; existe modo claro.

## Capabilities and Constraints

- Front sem framework: `index.html`, `style.css`, `app.js`, `wa_chat_logic.js`, `theme.js`, `personalizacao.js`. Back em Express (`api-server.js`) na Vercel, banco Cloudflare D1.
- Hospedagem no plano gratuito da Vercel: evitar trabalho que aumente chamadas à API.
- A **Agenda** fica fora de mudanças de layout: é delicada e a equipe pediu para não mexer nela.

## Brand Commitments

- O CRM é só da Natuclinic. A marca antiga (Gonecta) deve sair de vez: nome, favicon, logo, mascote e cores padrão.
- Logo da Natuclinic: `vendor/illustrations/natuclinic-logo.svg` (completa, branca) e `natuclinic-mark.svg` (símbolo de DNA, branco). Originais em `Desktop/natuclinic-site/public/`.
- Cores da marca: marrom `#4C261A` e rosa `#FFC2C2`, com os tons rosados da logo.

## Product Principles

1. Atendimento primeiro: a tela de conversa e o funil são onde a equipe passa o dia; eles definem a qualidade do produto.
2. Nada pode esconder um lead esperando resposta.
3. Mudança visual não pode quebrar fluxo de trabalho que a equipe já domina.
4. Custo de operação baixo: o plano gratuito da hospedagem é uma restrição real.

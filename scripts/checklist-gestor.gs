/**
 * Checklist do Gestor de Tráfego — marcação automática.
 *
 * Cola este arquivo em Extensões > Apps Script na planilha CHECKLIST.
 * Em Configurações do projeto > Propriedades do script, cria:
 *   CRM_URL              ex.: https://seu-crm.vercel.app  (sem barra no fim)
 *   GESTOR_BRIEFING_KEY  a mesma chave configurada no servidor do CRM
 *   EMAIL                (opcional) pra onde vai o briefing por e-mail
 * Depois roda "instalarHorarios" uma vez (ou pelo menu Checklist automática).
 *
 * O que faz: busca o briefing em /api/gestor/briefing, marca TRUE na coluna do
 * dia só nos itens que os dados do CRM confirmaram (com o número na nota da
 * célula), grava os indicadores na aba "Indicadores", o texto na aba "Briefing"
 * e manda por e-mail. Nunca desmarca nada — o que você marcou à mão fica.
 */

var ABA_CHECKLIST_GID = 2132959152;
var TZ = 'America/Sao_Paulo';

// Texto do item na planilha (sem acento, minúsculo, sem pontuação) -> chave do briefing.
// Chaves com @ são marcadas por este script depois de gravar as abas.
var ITENS = {
  'conferir todos os leads recebidos durante a noite': 'leads_noite',
  'conferir agenda comercial do dia': 'agenda',
  'conferir os retornos follow up programados': 'followups',
  'verificar campanhas ativas': 'campanhas_ativas',
  'organizar lista de prioridades do dia': 'prioridades',
  'conferir oportunidades de vendas pendentes': 'oportunidades',
  'conferir orcamento total': 'orcamento',

  'identificar qual criativo apresenta maior desempenho': 'criativo_top',
  'verificar ctr de cada criativo': 'ctr_criativos',
  'identificar criativos com fadiga': 'fadiga',
  'identificar criativos com melhor taxa de conversao': 'conversao_criativos',
  'registrar criativos vencedores': '@registro_criativo',

  'conferir quantidade de leads gerados': 'leads_gerados',
  'conferir custo por lead cpl': 'cpl',
  'conferir custo por clique cpc': 'cpc',
  'conferir cpm': 'cpm',
  'conferir ctr': 'ctr',
  'conferir frequencia dos anuncios': 'frequencia',
  'conferir alcance': 'alcance',
  'conferir impressoes': 'impressoes',
  'conferir taxa de conversao': 'taxa_conversao',
  'conferir roas': 'roas',
  'conferir investimento diario': 'invest_dia',
  'conferir investimento acumulado': 'invest_acum',
  'comparar desempenho com dias anteriores': 'comp_dias',
  'comparar desempenho semanal': 'comp_semana',
  'comparar desempenho mensal': 'comp_mes',

  'verificar links quebrados ou paginas com erro': 'site_links',
  'revisar titulos das paginas': 'site_titulos',
  'revisar descricoes das paginas meta description': 'site_descricoes',

  'conferir custo medio por lead': 'cpl_medio',
  'comparar campanhas que geram mais conversoes': 'campanhas_conversao',
  'identificar campanhas com maior retorno': 'campanhas_retorno',
  'acompanhar funil de geracao de leads': 'funil',

  'atualizar planilha de indicadores': '@registro',
  'registrar investimento diario': '@registro_meta',
  'registrar quantidade de leads': '@registro',
  'registrar cpl': '@registro_meta',
  'registrar cpc': '@registro_meta',
  'registrar ctr': '@registro_meta',
  'registrar roas': '@registro_meta',
  'registrar campanhas com melhor desempenho': '@registro_campanhas',
  'registrar campanhas com baixo desempenho': '@registro_campanhas',
  'elaborar relatorio diario': '@relatorio',

  'conferir se todas as campanhas permaneceram ativas': 'campanhas_ativas_fim',
  'conferir orcamento consumido': 'orcamento_consumido',
  'registrar indicadores do dia': '@registro',
  'salvar relatorios': '@relatorio',
  'atualizar planilhas': '@registro'
};

var COLUNAS_INDICADORES = [
  'Data', 'Momento', 'Gasto', 'Leads CRM', 'Resultados Meta', 'CPL', 'CPC', 'CPM', 'CTR %',
  'Frequência', 'Alcance', 'Impressões', 'Conversão semana %', 'Gasto mês', 'ROAS mês',
  'Melhor campanha', 'Pior campanha', 'Melhor criativo', 'Alertas'
];

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Checklist automática')
    .addItem('Rodar agora (manhã)', 'rodarManha')
    .addItem('Rodar agora (fim do dia)', 'rodarTarde')
    .addSeparator()
    .addItem('Instalar horários (8h e 18h)', 'instalarHorarios')
    .addItem('Começar semana nova', 'novaSemana')
    .addToUi();
}

function rodarManha() { rodar_('manha'); }
function rodarTarde() { rodar_('tarde'); }

function rodar_(momento) {
  var diaSemana = Number(Utilities.formatDate(new Date(), TZ, 'u')); // 1 = segunda ... 7 = domingo
  if (diaSemana === 7) return;

  var b = buscarBriefing_(momento);
  var ss = SpreadsheetApp.getActive();
  var hoje = Utilities.formatDate(new Date(), TZ, 'dd/MM/yyyy');
  var n = b.numeros || {};

  gravarLinha_(abaOuCria_(ss, 'Indicadores', COLUNAS_INDICADORES), hoje, momento, [
    hoje, momento === 'manha' ? 'Manhã' : 'Fim do dia',
    val_(n.gasto), n.leads_crm, val_(n.resultados_meta), val_(n.cpl), val_(n.cpc), val_(n.cpm), val_(n.ctr),
    val_(n.frequencia), val_(n.alcance), val_(n.impressoes), val_(n.conversao_semana_pct), val_(n.gasto_mes), val_(n.roas_mes),
    n.melhor_campanha || '', n.pior_campanha || '', n.melhor_criativo || '', (b.alertas || []).join('\n')
  ]);
  gravarLinha_(abaOuCria_(ss, 'Briefing', ['Data', 'Momento', 'Briefing']), hoje, momento, [
    hoje, momento === 'manha' ? 'Manhã' : 'Fim do dia', b.texto
  ]);

  var checklist = b.checklist || {};
  checklist['@registro'] = { ok: true, nota: 'aba Indicadores' };
  if (b.meta_atualizada) checklist['@registro_meta'] = { ok: true, nota: 'aba Indicadores' };
  if (n.melhor_criativo) checklist['@registro_criativo'] = { ok: true, nota: n.melhor_criativo };
  if (n.melhor_campanha) checklist['@registro_campanhas'] = { ok: true, nota: 'melhor: ' + n.melhor_campanha + (n.pior_campanha ? ' · pior: ' + n.pior_campanha : '') };
  if (momento === 'tarde') checklist['@relatorio'] = { ok: true, nota: 'aba Briefing' };

  var marcados = marcarChecklist_(ss, diaSemana, checklist);

  var email = PropertiesService.getScriptProperties().getProperty('EMAIL') || Session.getEffectiveUser().getEmail();
  if (email) MailApp.sendEmail(email, b.titulo, b.texto + '\n\n(' + marcados + ' item(ns) marcados na checklist)');
}

function buscarBriefing_(momento) {
  var props = PropertiesService.getScriptProperties();
  var url = (props.getProperty('CRM_URL') || '').replace(/\/+$/, '');
  var chave = props.getProperty('GESTOR_BRIEFING_KEY');
  if (!url || !chave) throw new Error('Falta CRM_URL ou GESTOR_BRIEFING_KEY nas Propriedades do script.');
  var r = UrlFetchApp.fetch(url + '/api/gestor/briefing?momento=' + momento, {
    headers: { Authorization: 'Bearer ' + chave },
    muteHttpExceptions: true
  });
  if (r.getResponseCode() !== 200) throw new Error('CRM respondeu ' + r.getResponseCode() + ': ' + r.getContentText().slice(0, 300));
  return JSON.parse(r.getContentText());
}

function marcarChecklist_(ss, diaSemana, checklist) {
  var aba = abaPorGid_(ss, ABA_CHECKLIST_GID);
  var col = 1 + diaSemana; // B = segunda ... G = sábado
  var textos = aba.getRange(1, 1, aba.getLastRow(), 1).getValues();
  var marcados = 0;
  for (var i = 0; i < textos.length; i++) {
    var chave = ITENS[normaliza_(textos[i][0])];
    var item = chave && checklist[chave];
    if (!item || !item.ok) continue;
    var cel = aba.getRange(i + 1, col);
    if (cel.getValue() !== true) { cel.setValue(true); marcados++; }
    if (item.nota) cel.setNote('Automático (' + Utilities.formatDate(new Date(), TZ, 'HH:mm') + '): ' + item.nota);
  }
  return marcados;
}

// Uma linha por dia + momento: rodar de novo atualiza em vez de duplicar.
function gravarLinha_(aba, hoje, momento, valores) {
  var rotulo = momento === 'manha' ? 'Manhã' : 'Fim do dia';
  var ultima = aba.getLastRow();
  if (ultima > 1) {
    var chaves = aba.getRange(2, 1, ultima - 1, 2).getDisplayValues();
    for (var i = 0; i < chaves.length; i++) {
      if (chaves[i][0] === hoje && chaves[i][1] === rotulo) {
        aba.getRange(i + 2, 1, 1, valores.length).setValues([valores]);
        return;
      }
    }
  }
  aba.appendRow(valores);
}

function abaOuCria_(ss, nome, cabecalho) {
  var aba = ss.getSheetByName(nome);
  if (aba) return aba;
  aba = ss.insertSheet(nome);
  aba.getRange(1, 1, 1, cabecalho.length).setValues([cabecalho]).setFontWeight('bold');
  aba.setFrozenRows(1);
  aba.getRange('A:A').setNumberFormat('@'); // data como texto, pra achar a linha de novo
  return aba;
}

function abaPorGid_(ss, gid) {
  var abas = ss.getSheets();
  for (var i = 0; i < abas.length; i++) if (abas[i].getSheetId() === gid) return abas[i];
  throw new Error('Aba da checklist (gid ' + gid + ') não encontrada.');
}

function normaliza_(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function val_(v) { return v === null || v === undefined ? '' : v; }

function instalarHorarios() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['rodarManha', 'rodarTarde'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  // O Apps Script dispara em algum minuto dentro da hora escolhida.
  ScriptApp.newTrigger('rodarManha').timeBased().atHour(8).everyDays(1).inTimezone(TZ).create();
  ScriptApp.newTrigger('rodarTarde').timeBased().atHour(18).everyDays(1).inTimezone(TZ).create();
  SpreadsheetApp.getActive().toast('Checklist automática às 8h e às 18h (seg a sáb).');
}

// Limpa as marcações da semana e atualiza a linha "DATA:" pra semana atual.
function novaSemana() {
  var ui = SpreadsheetApp.getUi();
  if (ui.alert('Começar semana nova?', 'Desmarca todos os itens de segunda a sábado e apaga as notas.', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  var aba = abaPorGid_(SpreadsheetApp.getActive(), ABA_CHECKLIST_GID);
  var ultima = aba.getLastRow();
  var faixa = aba.getRange(1, 2, ultima, 6);
  var valores = faixa.getValues();
  for (var i = 0; i < valores.length; i++) {
    for (var j = 0; j < 6; j++) if (valores[i][j] === true) valores[i][j] = false;
  }
  faixa.setValues(valores);
  faixa.clearNote();

  var hoje = new Date();
  var dow = Number(Utilities.formatDate(hoje, TZ, 'u'));
  var seg = new Date(hoje.getTime() - (dow - 1) * 86400000);
  var sab = new Date(seg.getTime() + 5 * 86400000);
  var textos = aba.getRange(1, 1, Math.min(ultima, 10), 1).getValues();
  for (var k = 0; k < textos.length; k++) {
    if (/^DATA:/i.test(String(textos[k][0]))) {
      aba.getRange(k + 1, 1).setValue('DATA: ' + Utilities.formatDate(seg, TZ, 'dd/MM') + ' a ' + Utilities.formatDate(sab, TZ, 'dd/MM'));
      break;
    }
  }
}

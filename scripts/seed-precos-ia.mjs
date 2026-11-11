// Carrega a tabela de preços da IA (crm_settings.precos_ia) a partir de um arquivo JSON,
// por exemplo o extraído da tela "Consultar valor dos procedimentos" do Amigo.
//
//   node scripts/seed-precos-ia.mjs                      só confere o arquivo (não toca em banco nenhum)
//   node scripts/seed-precos-ia.mjs --aplicar            grava no D1 do .env; recusa se já houver tabela salva
//   node scripts/seed-precos-ia.mjs --aplicar --sobrescrever   grava mesmo com tabela salva (troca tudo)
//   node scripts/seed-precos-ia.mjs outro-arquivo.json   usa outro arquivo (padrão: scratch/precos-amigo.json)
//
// O arquivo é { "precos": [{ nome, valor, condicao, informar }] }. Nada vem liberado para a IA
// (informar: false) a menos que o arquivo diga o contrário: quem libera é a clínica, na tela do Agente de IA.
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

const args = process.argv.slice(2);
const aplicar = args.includes('--aplicar');
const sobrescrever = args.includes('--sobrescrever');
const arquivo = args.find((a) => !a.startsWith('--')) || 'scratch/precos-amigo.json';

dotenv.config();

const lista = JSON.parse(fs.readFileSync(arquivo, 'utf8')).precos;
if (!Array.isArray(lista) || !lista.length) throw new Error('O arquivo não tem a lista "precos".');
if (lista.length > 1000) throw new Error('Mais de 1000 itens: o servidor recusaria.');
const ruins = lista.filter((p) => !String(p.nome || '').trim() || (p.valor !== null && !Number.isFinite(p.valor)));
if (ruins.length) throw new Error(`${ruins.length} linha(s) inválida(s) no arquivo (sem nome ou com valor que não é número).`);

const comValor = lista.filter((p) => p.valor !== null).length;
const liberados = lista.filter((p) => p.informar).length;
console.log(`Arquivo ${path.resolve(arquivo)}: ${lista.length} procedimentos, ${comValor} com valor, ${liberados} liberados para a IA.`);

if (!aplicar) {
  console.log('Só conferência. Nada foi gravado. Use --aplicar para gravar no banco do .env.');
  process.exit(0);
}

const { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, CLOUDFLARE_D1_DATABASE_ID } = process.env;
if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN || !CLOUDFLARE_D1_DATABASE_ID) throw new Error('Chaves da Cloudflare não configuradas no .env');

async function d1(sql, params = []) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database/${CLOUDFLARE_D1_DATABASE_ID}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params })
  });
  const j = await r.json();
  if (!j.success) throw new Error(j.errors?.[0]?.message || 'Erro na Cloudflare D1');
  return j.result[0].results || [];
}

const atual = await d1("SELECT value FROM crm_settings WHERE key = 'precos_ia'");
let existentes = 0;
try { existentes = atual[0] ? JSON.parse(atual[0].value).length : 0; } catch { existentes = -1; }
if (existentes !== 0 && !sobrescrever) {
  console.error(`Já existe uma tabela de preços salva (${existentes < 0 ? 'ilegível' : existentes + ' itens'}). Nada foi gravado. Use --sobrescrever se quiser trocá-la.`);
  process.exit(2);
}

await d1(
  "INSERT INTO crm_settings (key, value) VALUES ('precos_ia', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  [JSON.stringify(lista)]
);
const conferencia = await d1("SELECT value FROM crm_settings WHERE key = 'precos_ia'");
console.log(`Gravado: ${JSON.parse(conferencia[0].value).length} procedimentos em crm_settings.precos_ia.`);

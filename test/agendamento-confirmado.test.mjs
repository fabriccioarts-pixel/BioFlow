// node --test test/agendamento-confirmado.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { ehConfirmacaoDeAgendamento, interpretarChecagemFollowup } from '../agendamento-confirmado.js';

// Mensagens reais da equipe (nov/2026), nomes trocados.
const confirmam = [
    'Agendamento confirmado! Agradecemos pela confiança em nosso trabalho. Será um prazer receber você por aqui. ✨',
    'agendado ! te aguardamos\n\n_Mikaella – Natuclinic_',
    'Tudo certinho, Eduardo! Agendamento confirmado pra amanhã, às 14h, na nossa unidade de Planaltina. 😊',
    'Te agendei para o dia 21//11 às 09h00 tudo bem?',
    'Seu agendamento tá confirmadíssimo pra segunda-feira, dia 21, às 15h! Tudo certinho pra te receber por aqui. ✨',
    'Seu agendamento foi confirmado. Enviaremos uma mensagem de confirmação um dia antes do seu atendimento, tá bom?',
    'Seu agendamento está confirmado Fulana💖🥰',
    'Prontinho, Vitória! Agendado com sucesso pra sábado, dia 19, às 10h, na nossa unidade de Taguatinga Norte. 😊',
    'Prontinho, Iranilda! Seu agendamento está confirmado para o dia 11, às 16h30, na nossa unidade de Taguatinga Norte.',
    'Prontinho, Bete! Ficou agendado pro próximo sábado, às 8h. Te esperamos por aqui! 😊',
    'Prontinho! O retorno dela tá confirmado pro dia 5, às 14:20, na unidade de Taguatinga. Qualquer dúvida é só me chamar.',
    'Prontinho agendado para as 14:20 o seu retorno. 😉',
    'Perfeito, agendado!',
    'Perfeito, Paloma! Agendamento confirmado pra sexta, dia 16, às *15h* 😊  No dia, a equipe faz sua avaliação',
];

const naoConfirmam = [
    'Podemos deixar agendado?\n\n_Mikaella – Natuclinic_',
    'podemos já deixar agendado?',
    'Tranquilo Joaquim! Já podemos deixar agendado caso preferir',
    'Teria uma previsão mais ou menos? Que eu posso deixar você pré agendada ai você pode confirmar quando conseguir',
    'Que tal a gente já deixar a sua avaliação agendada? Você prefere vir no período da manhã ou da tarde? 😊',
    'Que bom que gostou! ✨ Quer aproveitar pra já deixar agendado o seu horário, nosso sábado acabou de ser preenchido',
    'Podemos deixar agendado para essa semana agora?',
    'Para o agendamento, me envie os seguintes dados: Nome Completo: Data de Nascimento: E-mail: Telefone:',
    'Ótimo! Pra confirmar essa vaga de paciente modelo, a taxa da avaliação, que é R$ 250, fica',
    'Tenho disponibilidade já para a próxima semana. Você tem interesse em agendar?',
    'Oi Maria vamos ter que reagendar sua consulta para o dia 26',
    '📋 _Template: follow_up_2_ Oi Rosy, Passando rapidinho...',
    '[FILE:foto.jpg]/api/whatsapp/media/1.jpg',
    '',
];

test('reconhece as confirmações reais da equipe', () => {
    for (const t of confirmam) assert.equal(ehConfirmacaoDeAgendamento(t), true, t);
});

test('não confunde proposta, pergunta ou pedido de dados com confirmação', () => {
    for (const t of naoConfirmam) assert.equal(ehConfirmacaoDeAgendamento(t), false, t);
});

test('checagem do follow-up: encerrada, adiar e aberta', () => {
    assert.deepEqual(interpretarChecagemFollowup('ENCERRADA: agendamento confirmado', '2026-11-23'), { tipo: 'encerrada', motivo: 'agendamento confirmado' });
    assert.deepEqual(interpretarChecagemFollowup('ADIAR: 2026-11-24 | paciente confirma na segunda', '2026-11-23'),
        { tipo: 'adiar', data: '2026-11-24', motivo: 'paciente confirma na segunda' });
    assert.equal(interpretarChecagemFollowup('ADIAR: 2026-11-24', '2026-11-23').motivo, 'paciente combinou de retornar');
    assert.deepEqual(interpretarChecagemFollowup('ABERTA', '2026-11-23'), { tipo: 'aberta' });
    assert.deepEqual(interpretarChecagemFollowup('', '2026-11-23'), { tipo: 'aberta' });
});

test('adiar com data ruim, passada ou longe demais vira aberta (não trava o follow-up)', () => {
    assert.equal(interpretarChecagemFollowup('ADIAR: 2026-11-23 | hoje', '2026-11-23').tipo, 'aberta');
    assert.equal(interpretarChecagemFollowup('ADIAR: 2026-11-10 | passado', '2026-11-23').tipo, 'aberta');
    assert.equal(interpretarChecagemFollowup('ADIAR: 2027-03-01 | longe', '2026-11-23').tipo, 'aberta');
    assert.equal(interpretarChecagemFollowup('ADIAR: segunda', '2026-11-23').tipo, 'aberta');
});

// Server2.js
import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import cors from 'cors';

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// ======================= ENV =======================
const RD_CRM_API_TOKEN = process.env.RD_CRM_API_TOKEN;

const RD_CLIENT_ID = process.env.RD_CLIENT_ID;
const RD_CLIENT_SECRET = process.env.RD_CLIENT_SECRET;
const RD_REDIRECT_URI = process.env.RD_REDIRECT_URI;

// ======================= URLS =======================
const RD_CRM_ORGANIZATIONS_URL = 'https://crm.rdstation.com/api/v1/organizations';
const RD_CRM_TOKEN_CHECK_URL = 'https://crm.rdstation.com/api/v1/token/check';

const RD_OAUTH_DIALOG_URL = 'https://api.rd.services/auth/dialog';
const RD_OAUTH_TOKEN_URL = 'https://api.rd.services/auth/token';

console.log('Token CRM legado carregado?', !!RD_CRM_API_TOKEN);
console.log('OAuth client_id carregado?', !!RD_CLIENT_ID);
console.log('OAuth client_secret carregado?', !!RD_CLIENT_SECRET);
console.log('OAuth redirect_uri carregado?', !!RD_REDIRECT_URI);

// ======================= FUNÇÕES AUXILIARES =======================
function onlyDigits(value = '') {
  return String(value || '').replace(/\D/g, '');
}

function safeString(value = '') {
  return String(value || '').trim();
}

function buildCustomField(custom_field_id, value) {
  const finalValue = String(value ?? '').trim();
  if (!finalValue) return null;

  return {
    custom_field_id,
    value: finalValue
  };
}

// busca paginada por CNPJ
async function findOrganizationByCnpj(cnpjDigits, maxPages = 5) {
  const cleanCnpj = onlyDigits(cnpjDigits);
  if (!cleanCnpj || !RD_CRM_API_TOKEN) return null;

  for (let page = 1; page <= maxPages; page++) {
    console.log(`🔎 Buscando organização por CNPJ (página ${page})...`);

    const resp = await fetch(
      `${RD_CRM_ORGANIZATIONS_URL}?token=${RD_CRM_API_TOKEN}&page=${page}&limit=150`,
      { method: 'GET', headers: { accept: 'application/json' } }
    );

    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!resp.ok) {
      console.warn(`⚠️ Falha ao listar organizações na página ${page}:`, resp.status, text);
      break;
    }

    const orgs = Array.isArray(data.organizations) ? data.organizations : [];
    const match = orgs.find(org => {
      const fields = org.organization_custom_fields || [];
      const cnpjField = fields.find(
        f => f.custom_field_id === '69b1c6040143ed00183457da'
      );
      return cnpjField && onlyDigits(cnpjField.value) === cleanCnpj;
    });

    if (match) {
      console.log(`✅ Organização encontrada na página ${page}:`, match.id);
      return match;
    }

    if (!data.has_more) {
      console.log('ℹ️ Não há mais páginas de organizações.');
      break;
    }
  }

  console.log('ℹ️ Nenhuma organização encontrada para este CNPJ após paginação.');
  return null;
}

// ======================= ROTA RAIZ =======================
app.get('/', (req, res) => {
  return res.send('Servidor RD Webhook + OAuth online.');
});

// ======================= HEALTH CHECK =======================
app.get('/health', async (req, res) => {
  try {
    if (!RD_CRM_API_TOKEN) {
      return res.status(400).json({
        success: false,
        error: 'RD_CRM_API_TOKEN não configurado no .env'
      });
    }

    const response = await fetch(RD_CRM_TOKEN_CHECK_URL, {
      method: 'GET',
      headers: {
        Authorization: `Token token=${RD_CRM_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    const text = await response.text();
    console.log('🔎 /health:', response.status, text);

    return res.status(response.status).send(text);
  } catch (err) {
    console.error('❌ Erro no /health:', err);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// ======================= OAUTH RD STATION =======================

// inicia autorização OAuth
app.get('/auth/rd', async (req, res) => {
  try {
    if (!RD_CLIENT_ID || !RD_CLIENT_SECRET || !RD_REDIRECT_URI) {
      return res.status(500).json({
        success: false,
        error: 'Credenciais OAuth ausentes no .env'
      });
    }

    const authUrl =
      `${RD_OAUTH_DIALOG_URL}?client_id=${encodeURIComponent(RD_CLIENT_ID)}` +
      `&redirect_uri=${encodeURIComponent(RD_REDIRECT_URI)}`;

    console.log('🔐 Redirecionando para autorização OAuth RD:', authUrl);
    return res.redirect(authUrl);
  } catch (err) {
    console.error('❌ Erro ao iniciar OAuth RD:', err);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// callback OAuth – troca code por tokens
app.get('/auth/rd/callback', async (req, res) => {
  try {
    const { code } = req.query;

    if (!code) {
      return res.status(400).json({
        success: false,
        error: 'Code não recebido no callback.'
      });
    }

    console.log('📥 Code recebido do RD:', code);

    const tokenResponse = await fetch(`${RD_OAUTH_TOKEN_URL}?token_by=code`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        client_id: RD_CLIENT_ID,
        client_secret: RD_CLIENT_SECRET,
        code
      })
    });

    const tokenText = await tokenResponse.text();
    console.log('📥 Resposta token OAuth RD:', tokenResponse.status, tokenText);

    let tokenData;
    try { tokenData = JSON.parse(tokenText); } catch { tokenData = { raw: tokenText }; }

    if (!tokenResponse.ok) {
      return res.status(tokenResponse.status).json({
        success: false,
        action: 'oauth_token',
        status: tokenResponse.status,
        error: tokenData
      });
    }

    return res.status(200).json({
      success: true,
      message: 'OAuth autorizado com sucesso.',
      oauth: tokenData
    });
  } catch (err) {
    console.error('❌ Erro no callback OAuth RD:', err);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// refresh token — CORRIGIDO ✅
app.post('/auth/rd/refresh', async (req, res) => {
  try {
    const { refresh_token } = req.body;

    if (!refresh_token) {
      return res.status(400).json({
        success: false,
        error: 'refresh_token não enviado.'
      });
    }

    const refreshResponse = await fetch(`${RD_OAUTH_TOKEN_URL}?token_by=refresh_token`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        client_id: RD_CLIENT_ID,
        client_secret: RD_CLIENT_SECRET,
        refresh_token
      })
    });

    const refreshText = await refreshResponse.text();
    console.log('📥 Resposta refresh OAuth RD:', refreshResponse.status, refreshText);

    let refreshData;
    try { refreshData = JSON.parse(refreshText); } catch { refreshData = { raw: refreshText }; }

    if (!refreshResponse.ok) {
      return res.status(refreshResponse.status).json({
        success: false,
        action: 'oauth_refresh',
        status: refreshResponse.status,
        error: refreshData
      });
    }

    return res.status(200).json({
      success: true,
      oauth: refreshData
    });
  } catch (err) {
    console.error('❌ Erro ao renovar token OAuth RD:', err);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// ======================= WEBHOOK ANTIGO =======================
app.post('/rdstation-webhook', async (req, res) => {
  return res.status(501).json({
    success: false,
    message: 'Rota antiga não usada pela nova LP.'
  });
});

// ======================= WEBHOOK CAMPANHA =======================
// responde 200 rápido; processamento em background
app.post('/rdstation-webhook-campanha', async (req, res) => {
  const payload = req.body;

  console.log('📥 Webhook LP ENTRE MUNDOS recebido');

  res.status(200).json({
    success: true,
    message: 'Webhook recebido com sucesso.'
  });

  try {
    console.log('➡️ Iniciando processamento em background...');
    console.log(JSON.stringify(payload, null, 2));

    if (!RD_CRM_API_TOKEN) {
      console.error('❌ RD_CRM_API_TOKEN não configurado no .env');
      return;
    }

    const lead = payload?.leads?.[0];
    if (!lead) {
      console.error('❌ Payload inválido: leads[0] não encontrado.');
      return;
    }

    const content =
      lead.first_conversion?.content ||
      lead.custom_fields ||
      lead.content ||
      {};

    const customFields = lead.custom_fields || {};

    console.log('➡️ Iniciando normalização de campos...');

    const razaoSocial =
      safeString(content.cf_razao_social) ||
      safeString(customFields.cf_razao_social) ||
      safeString(lead.company) ||
      safeString(lead.name) ||
      `Empresa ${Date.now()}`;

    const nomeFantasia =
      safeString(content.cf_nome_fantasia) ||
      safeString(customFields.cf_nome_fantasia) ||
      safeString(lead.name);

    const endereco =
      safeString(content.cf_endereco) ||
      safeString(content['Endereço']) ||
      safeString(customFields.cf_endereco) ||
      safeString(customFields['Endereço']);

    const numero =
      safeString(content.cf_numero) ||
      safeString(customFields.cf_numero);

    const bairro =
      safeString(content.cf_bairro) ||
      safeString(customFields.cf_bairro);

    const cidade =
      safeString(content.cf_cidade) ||
      safeString(customFields.cf_cidade);

    const estadoBruto =
      safeString(content.cf_estado) ||
      safeString(content.state) ||
      safeString(content['Estado Aberto']) ||
      safeString(customFields.cf_estado) ||
      safeString(lead.state);

    let uf = estadoBruto.toUpperCase();

    const NOME_PARA_UF = {
      'SAO PAULO': 'SP',
      'SÃO PAULO': 'SP',
      'RIO DE JANEIRO': 'RJ',
      'MINAS GERAIS': 'MG',
      'ESPIRITO SANTO': 'ES',
      'ESPÍRITO SANTO': 'ES'
    };

    if (NOME_PARA_UF[uf]) uf = NOME_PARA_UF[uf];
    const estadoFinal = uf;

    const cep = onlyDigits(content.cf_cep || customFields.cf_cep);

    const telefone = onlyDigits(
      content.cf_telefone ||
      content.Telefone ||
      customFields.cf_telefone ||
      lead.personal_phone ||
      lead.mobile_phone ||
      lead.phone
    );

    const email =
      safeString(lead.email) ||
      safeString(content.email_lead);

    const representanteLegal =
      safeString(content.cf_representante_legal) ||
      safeString(customFields.cf_representante_legal);

    const cpfRepresentante =
      onlyDigits(content.cf_cpf_representante || customFields.cf_cpf_representante);

    const rgRepresentante =
      safeString(content.cf_rg_representante || customFields.cf_rg_representante);

    const cnpj = onlyDigits(
      content.cf_cnpj ||
      customFields.cf_cnpj
    );

    const opcaoCampanha =
      safeString(content.cf_opcao_campanha) ||
      safeString(customFields['Entre Mundos 2026']) ||
      safeString(customFields.cf_entre_mundos_2026);

    console.log('🧾 Campos normalizados (LP -> CRM):');
    console.log(JSON.stringify({
      razaoSocial,
      nomeFantasia,
      cnpj,
      endereco,
      numero,
      bairro,
      cidade,
      estadoBruto,
      estadoFinal,
      cep,
      telefone,
      email,
      representanteLegal,
      cpfRepresentante,
      rgRepresentante,
      opcaoCampanha
    }, null, 2));

    if (!cnpj) {
      console.error('❌ CNPJ vazio ou inválido. Não é possível criar organização sem CNPJ.');
      return;
    }

    console.log('➡️ Antes findOrganizationByCnpj...');
    const existingOrg = await findOrganizationByCnpj(cnpj, 5);
    console.log('✅ Depois findOrganizationByCnpj.');

    const organizationCustomFields = [
      buildCustomField('69b1c5f1473b730016d41971', razaoSocial),
      buildCustomField('69b1c5f75ea3200016f49791', nomeFantasia),
      buildCustomField('69b1c6040143ed00183457da', cnpj),
      buildCustomField('69b1c672a433580013d56a20', endereco),
      buildCustomField('69b1d0286520a80020939657', numero),
      buildCustomField('68ef934223f4b30014fd1ffd', bairro),
      buildCustomField('68ef9349528c560019741cc4', cidade),
      buildCustomField('69c189f58ae16600131fc9ac', estadoFinal),
      buildCustomField('69b1c68705e89500133632dc', cep),
      buildCustomField('69bc03a3f67e550016a1b98e', telefone),
      buildCustomField('68ef934c752228001c5ef627', email),
      buildCustomField('69b1c6a33068d1001cb0823f', representanteLegal),
      buildCustomField('69b1c62d459e5400184503dc', cpfRepresentante),
      buildCustomField('69b1c6451eb5e50021d115b7', rgRepresentante),
      buildCustomField('69c7ec9d7080a10014eb9060', opcaoCampanha)
    ].filter(Boolean);

    if (existingOrg) {
      console.log('ℹ️ Empresa já existente encontrada via busca. Nenhum create será feito.');
      console.log('🏢 Organização encontrada:', existingOrg.id);
      return;
    }

    const createPayload = {
      organization: {
        name: razaoSocial,
        organization_custom_fields: organizationCustomFields
      }
    };

    console.log('📤 Criando nova organização no CRM (CAMPANHA):');
    console.log(JSON.stringify(createPayload, null, 2));

    console.log('➡️ Antes create fetch...');
    const createResponse = await fetch(
      `${RD_CRM_ORGANIZATIONS_URL}?token=${RD_CRM_API_TOKEN}`,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: JSON.stringify(createPayload)
      }
    );
    console.log('✅ Depois create fetch.');

    const createText = await createResponse.text();
    console.log('📥 Resposta create CAMPANHA:', createResponse.status, createText);

    let createData;
    try { createData = JSON.parse(createText); } catch { createData = { raw: createText }; }

    const nameErrors = createData?.errors?.name || [];
    const isAlreadyRegistered = nameErrors.includes('Empresa já cadastrada.');

    if (!createResponse.ok) {
      if (createResponse.status === 422 && isAlreadyRegistered) {
        console.log('ℹ️ 422 Empresa já cadastrada. Considerando sucesso.');
        return;
      }

      console.error('❌ Erro no create da organização:', createResponse.status, createData);
      return;
    }

    console.log('✅ Organização criada com sucesso:', createData);

  } catch (err) {
    console.error('❌ Erro crítico no webhook CRM CAMPANHA:', err);
  }
});

// ======================= START =======================
app.listen(PORT, () => {
  console.log(`✅ Servidor RD Webhook rodando em http://localhost:${PORT}`);
});

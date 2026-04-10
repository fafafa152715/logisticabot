const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const TOKEN = process.env.BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;

const bot = new TelegramBot(TOKEN, { polling: true });

const operadores = {};
const viajesSemana = [];
const userState = {};

async function procesarFotoConGemini(imageBuffer, tipo) {
  const base64 = imageBuffer.toString('base64');
  let prompt = '';
  if (tipo === 'kilometraje') {
    prompt = 'Foto del odómetro de un camión. Extrae el número de kilómetros. Responde SOLO en JSON: {"kilometraje": 123456}';
  } else if (tipo === 'ticket') {
    prompt = 'Foto de ticket de diésel. Extrae: número de vale, litros, costo por litro, total, fecha. Responde SOLO en JSON: {"vale": "123", "litros": 300, "costo_litro": 27.5, "total": 8250, "fecha": "2026-04-10"}';
  } else if (tipo === 'vale') {
    prompt = 'Foto de un vale o remisión. Extrae el número de vale. Responde SOLO en JSON: {"numero_vale": "172122"}';
  } else if (tipo === 'gastos') {
    prompt = 'Foto de comprobantes de gastos de operador de camión. Extrae conceptos y montos. Responde SOLO en JSON: {"gastos": [{"concepto": "comida", "monto": 150}], "total": 350}';
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    contents: [{ parts: [{ inline_data: { mime_type: 'image/jpeg', data: base64 } }, { text: prompt }] }]
  };
  const response = await axios.post(url, body);
  const text = response.data.candidates[0].content.parts[0].text;
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    return { raw: text };
  } catch { return { raw: text }; }
}

async function descargarFoto(fileId) {
  const file = await bot.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  return Buffer.from(response.data);
}

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const isAdmin = String(chatId) === String(ADMIN_ID);
  if (isAdmin) {
    bot.sendMessage(chatId,
      `👋 Bienvenido Admin!\n\n📋 *Comandos:*\n\n/nuevos_viajes - Registrar viajes\n/ver_viajes - Ver viajes\n/operadores - Ver operadores`,
      { parse_mode: 'Markdown' });
  } else {
    bot.sendMessage(chatId,
      `👋 Bienvenido al Bot de Logística MUBIN 🚛\n\nPara registrarte:\n/registrar NOMBRE TRACTO\n\nEjemplo: /registrar Rafael 9`);
  }
});

bot.onText(/\/registrar (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const parts = match[1].trim().split(' ');
  if (parts.length < 2) return bot.sendMessage(chatId, '❌ Usa: /registrar NOMBRE TRACTO\nEjemplo: /registrar Rafael 9');
  const nombre = parts[0];
  const tracto = parts[1];
  operadores[chatId] = { nombre, tracto, chatId };
  bot.sendMessage(chatId, `✅ Registrado como *${nombre}* - Tracto #${tracto}`, { parse_mode: 'Markdown' });
  if (ADMIN_ID) bot.sendMessage(ADMIN_ID, `🚛 Nuevo operador: *${nombre}* - Tracto #${tracto}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/nuevos_viajes/, (msg) => {
  const chatId = msg.chat.id;
  if (String(chatId) !== String(ADMIN_ID)) return;
  userState[chatId] = { estado: 'esperando_viajes' };
  viajesSemana.length = 0;
  bot.sendMessage(chatId,
    `📋 *Viajes de la semana*\n\nEnvía uno por línea:\nFECHA | CLIENTE | DESTINO | HORA\n\nEjemplo:\nLunes 13 | Conagra | Local | 4:30pm\nMartes 14 | Pulses GDL | Irap-GDL | Sin cita\n\nEscribe *fin* cuando termines`,
    { parse_mode: 'Markdown' });
});

bot.onText(/\/ver_viajes/, (msg) => {
  const chatId = msg.chat.id;
  if (String(chatId) !== String(ADMIN_ID)) return;
  if (viajesSemana.length === 0) return bot.sendMessage(chatId, '❌ No hay viajes registrados.');
  let lista = '📋 *Viajes de la semana:*\n\n';
  viajesSemana.forEach((v, i) => {
    lista += `${i + 1}. ${v.fecha} | ${v.cliente} | ${v.destino} | ${v.hora} | 👤 ${v.operador || 'Sin asignar'}\n`;
  });
  lista += `\n/asignar NUMERO NOMBRE\nEjemplo: /asignar 1 Rafael`;
  bot.sendMessage(chatId, lista, { parse_mode: 'Markdown' });
});

bot.onText(/\/asignar (\d+) (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  if (String(chatId) !== String(ADMIN_ID)) return;
  const idx = parseInt(match[1]) - 1;
  const nombreOperador = match[2].trim();
  if (!viajesSemana[idx]) return bot.sendMessage(chatId, '❌ Número de viaje incorrecto.');
  viajesSemana[idx].operador = nombreOperador;
  const entry = Object.entries(operadores).find(([, op]) => op.nombre.toLowerCase() === nombreOperador.toLowerCase());
  if (entry) {
    const [opChatId] = entry;
    bot.sendMessage(opChatId,
      `🚛 *Nuevo viaje asignado:*\n\n📅 ${viajesSemana[idx].fecha}\n🏭 ${viajesSemana[idx].cliente}\n📍 ${viajesSemana[idx].destino}\n🕐 ${viajesSemana[idx].hora}\n\nResponde con /confirmar`,
      { parse_mode: 'Markdown' });
    bot.sendMessage(chatId, `✅ Asignado a *${nombreOperador}* y notificado.`, { parse_mode: 'Markdown' });
  } else {
    bot.sendMessage(chatId, `⚠️ Viaje asignado pero *${nombreOperador}* no está registrado aún.`, { parse_mode: 'Markdown' });
  }
});

bot.onText(/\/operadores/, (msg) => {
  const chatId = msg.chat.id;
  if (String(chatId) !== String(ADMIN_ID)) return;
  if (Object.keys(operadores).length === 0) return bot.sendMessage(chatId, '❌ No hay operadores registrados.');
  let lista = '🚛 *Operadores:*\n\n';
  Object.values(operadores).forEach(op => { lista += `• ${op.nombre} - Tracto #${op.tracto}\n`; });
  bot.sendMessage(chatId, lista, { parse_mode: 'Markdown' });
});

bot.onText(/\/confirmar/, (msg) => {
  const chatId = msg.chat.id;
  const operador = operadores[chatId];
  if (!operador) return bot.sendMessage(chatId, '❌ No estás registrado. Usa /registrar NOMBRE TRACTO');
  userState[chatId] = { estado: 'esperando_remision' };
  bot.sendMessage(chatId, `✅ Viaje confirmado!\n\nEnvíame el *número de remisión* y *número de caja*\n\nEjemplo: Remisión 12345, Caja 67`, { parse_mode: 'Markdown' });
});

bot.onText(/\/diesel/, (msg) => {
  const chatId = msg.chat.id;
  const operador = operadores[chatId];
  if (!operador) return bot.sendMessage(chatId, '❌ No estás registrado. Usa /registrar NOMBRE TRACTO');
  userState[chatId] = { estado: 'esperando_km', diesel: {} };
  bot.sendMessage(chatId, `⛽ *Reporte de Diésel*\n\nPaso 1 de 3: Envía 📸 foto del *kilometraje*`, { parse_mode: 'Markdown' });
});

bot.onText(/\/gastos/, (msg) => {
  const chatId = msg.chat.id;
  const operador = operadores[chatId];
  if (!operador) return bot.sendMessage(chatId, '❌ No estás registrado. Usa /registrar NOMBRE TRACTO');
  userState[chatId] = { estado: 'esperando_foto_gastos' };
  bot.sendMessage(chatId, `💰 *Gastos Semanales*\n\nEnvía 📸 foto de tus comprobantes:`, { parse_mode: 'Markdown' });
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const estado = userState[chatId]?.estado;
  if (!msg.text || msg.text.startsWith('/')) return;

  if (estado === 'esperando_viajes') {
    if (msg.text.toLowerCase() === 'fin') {
      userState[chatId] = { estado: null };
      if (viajesSemana.length === 0) return bot.sendMessage(chatId, '❌ No hay viajes.');
      let lista = `✅ *${viajesSemana.length} viajes registrados:*\n\n`;
      viajesSemana.forEach((v, i) => { lista += `${i + 1}. ${v.fecha} | ${v.cliente} | ${v.destino} | ${v.hora}\n`; });
      lista += `\n/asignar NUMERO NOMBRE\nEjemplo: /asignar 1 Rafael`;
      return bot.sendMessage(chatId, lista, { parse_mode: 'Markdown' });
    }
    const lineas = msg.text.split('\n').filter(l => l.trim());
    let agregados = 0;
    lineas.forEach(linea => {
      const partes = linea.split('|').map(p => p.trim());
      if (partes.length >= 3) {
        viajesSemana.push({ fecha: partes[0], cliente: partes[1], destino: partes[2], hora: partes[3] || 'Sin cita', operador: null });
        agregados++;
      }
    });
    return bot.sendMessage(chatId, `✅ ${agregados} viajes agregados. Sigue o escribe *fin*`, { parse_mode: 'Markdown' });
  }

  if (estado === 'esperando_remision') {
    const operador = operadores[chatId];
    userState[chatId] = { estado: null };
    if (ADMIN_ID) bot.sendMessage(ADMIN_ID, `📦 *${operador.nombre}* confirma:\n\n${msg.text}`, { parse_mode: 'Markdown' });
    bot.sendMessage(chatId, '✅ Datos enviados. ¡Buen viaje! 🚛');
  }
});

bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const estado = userState[chatId]?.estado;
  const operador = operadores[chatId];
  if (!operador && String(chatId) !== String(ADMIN_ID)) return bot.sendMessage(chatId, '❌ No estás registrado. Usa /registrar NOMBRE TRACTO');
  const fileId = msg.photo[msg.photo.length - 1].file_id;

  try {
    if (estado === 'esperando_km') {
      await bot.sendMessage(chatId, '⏳ Leyendo kilometraje...');
      const buffer = await descargarFoto(fileId);
      const datos = await procesarFotoConGemini(buffer, 'kilometraje');
      userState[chatId] = { estado: 'esperando_ticket', diesel: { kilometraje: datos.kilometraje || 'ver foto' } };
      bot.sendMessage(chatId, `✅ Km: *${datos.kilometraje || 'continúa'}*\n\nPaso 2 de 3: Envía 📸 foto del *ticket de diésel*`, { parse_mode: 'Markdown' });
      return;
    }
    if (estado === 'esperando_ticket') {
      await bot.sendMessage(chatId, '⏳ Leyendo ticket...');
      const buffer = await descargarFoto(fileId);
      const datos = await procesarFotoConGemini(buffer, 'ticket');
      userState[chatId].estado = 'esperando_vale';
      userState[chatId].diesel.ticket = datos;
      bot.sendMessage(chatId, `✅ Ticket leído!\n\nPaso 3 de 3: Envía 📸 foto del *vale*`, { parse_mode: 'Markdown' });
      return;
    }
    if (estado === 'esperando_vale') {
      await bot.sendMessage(chatId, '⏳ Leyendo vale...');
      const buffer = await descargarFoto(fileId);
      const datos = await procesarFotoConGemini(buffer, 'vale');
      const diesel = userState[chatId].diesel;
      diesel.vale = datos.numero_vale || 'ver foto';
      userState[chatId] = { estado: null };
      const fecha = new Date().toLocaleDateString('es-MX');
      const resumen = `⛽ *Reporte de Diésel*\n\n👤 ${operador.nombre}\n🚛 Tracto #${operador.tracto}\n📅 ${fecha}\n📏 Km: ${diesel.kilometraje}\n🔢 Vale: ${diesel.vale}\n💧 Litros: ${diesel.ticket?.litros || 'N/A'}\n💰 Total: $${diesel.ticket?.total || 'N/A'}`;
      bot.sendMessage(chatId, resumen + '\n\n✅ Enviado al administrador.', { parse_mode: 'Markdown' });
      if (ADMIN_ID) bot.sendMessage(ADMIN_ID, resumen, { parse_mode: 'Markdown' });
      return;
    }
    if (estado === 'esperando_foto_gastos') {
      await bot.sendMessage(chatId, '⏳ Leyendo comprobantes...');
      const buffer = await descargarFoto(fileId);
      const datos = await procesarFotoConGemini(buffer, 'gastos');
      userState[chatId] = { estado: null };
      const fecha = new Date().toLocaleDateString('es-MX');
      let resumen = `💰 *Gastos Semanales*\n\n👤 ${operador.nombre} - Tracto #${operador.tracto}\n📅 ${fecha}\n\n`;
      if (datos.gastos && Array.isArray(datos.gastos)) {
        datos.gastos.forEach(g => { resumen += `• ${g.concepto}: $${g.monto}\n`; });
        resumen += `\n*Total: $${datos.total || 'N/A'}*`;
      } else { resumen += datos.raw || 'Ver foto'; }
      bot.sendMessage(chatId, '✅ Gastos enviados al administrador.', { parse_mode: 'Markdown' });
      if (ADMIN_ID) bot.sendMessage(ADMIN_ID, resumen, { parse_mode: 'Markdown' });
      return;
    }
  } catch (error) {
    console.error('Error:', error);
    bot.sendMessage(chatId, '❌ Error procesando foto. Intenta de nuevo.');
  }
});

console.log('🚛 Bot de Logística MUBIN iniciado...');

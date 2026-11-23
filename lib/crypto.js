const crypto = require('crypto');

function getKey() {
  const k = process.env.ENCRYPTION_KEY || '';
  if (!/^[0-9a-fA-F]{64}$/.test(k)) {
    throw new Error('ENCRYPTION_KEY inválida: precisa ter 64 caracteres hexadecimais');
  }
  return Buffer.from(k, 'hex');
}

// AES-256-GCM: retorna "iv:tag:dados" em hex
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('hex')).join(':');
}

function decrypt(payload) {
  const [iv, tag, enc] = payload.split(':').map((h) => Buffer.from(h, 'hex'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };

const fs = require('fs');
const path = require('path');

const DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DIR, { recursive: true });

function load(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));
  } catch {
    return fallback;
  }
}

// Escrita atômica: grava em arquivo temporário e renomeia
function save(name, data) {
  const file = path.join(DIR, name);
  fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}

module.exports = { load, save };

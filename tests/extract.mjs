// Extrait les fonctions pures et constantes de index.html pour les tester
// avec Node, sans navigateur. L'app est volontairement un fichier unique :
// on découpe ici par comptage d'accolades (les fonctions ciblées n'ont pas
// d'accolades non appariées dans leurs strings/regex/commentaires).
import { readFileSync } from 'node:fs';

const CONSTS = ['SCHEMA_VERSION', 'DEFAULT_STATE', 'SYNC_SYNCABLE_FIELDS'];
const FUNCTIONS = [
  'now', 'safeUrl', 'uid', 'fmtDate', 'parseDateLocal', 'isLate', 'isSoon',
  'normalizeState', 'mergeStates'
];

export function extractChaletCode() {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const parts = [
    ...CONSTS.map(name => extractConst(html, name)),
    ...FUNCTIONS.map(name => extractFunction(html, name))
  ];
  const names = [...CONSTS, ...FUNCTIONS].join(', ');
  const src = parts.join('\n') + `\nreturn { ${names} };`;
  return new Function(src)();
}

function extractFunction(html, name) {
  const start = html.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} introuvable dans index.html`);
  const bodyOpen = html.indexOf('{', start);
  const end = matchBrace(html, bodyOpen, '{', '}');
  return html.slice(start, end + 1);
}

function extractConst(html, name) {
  const start = html.indexOf(`const ${name} =`);
  if (start === -1) throw new Error(`const ${name} introuvable dans index.html`);
  let i = html.indexOf('=', start) + 1;
  while (/\s/.test(html[i])) i++;
  let end;
  if (html[i] === '{') end = matchBrace(html, i, '{', '}');
  else if (html[i] === '[') end = matchBrace(html, i, '[', ']');
  else end = html.indexOf(';', i) - 1;
  return html.slice(start, end + 1) + ';';
}

function matchBrace(html, openIdx, open, close) {
  let depth = 0;
  for (let i = openIdx; i < html.length; i++) {
    if (html[i] === open) depth++;
    else if (html[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`Accolade non fermée à partir de l'index ${openIdx}`);
}

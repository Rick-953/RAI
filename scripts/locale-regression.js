'use strict';

const assert = require('node:assert/strict');
const createLocale = require('../public/locale.js');

function fixture(languages, saved, blocked = false) {
  const values = new Map(saved ? [['rai_language', saved]] : []);
  const handlers = {};
  const host = {
    navigator: { languages, language: languages?.[0] },
    document: { documentElement: {} },
    addEventListener: (event, listener) => { handlers[event] = listener; },
    localStorage: {
      getItem: key => { if (blocked) throw Error('blocked'); return values.get(key) ?? null; },
      setItem: (key, value) => { if (blocked) throw Error('blocked'); values.set(key, value); },
      removeItem: key => { if (blocked) throw Error('blocked'); values.delete(key); }
    }
  };
  return { api: createLocale(host), host, values, handlers };
}

for (const [languages, expected] of [
  [['en-US'], 'en'], [['en-GB'], 'en'], [['zh-CN'], 'zh-CN'],
  [['zh-TW'], 'zh-CN'], [['zh-Hant-HK'], 'zh-CN'], [['zh_SG'], 'zh-CN'],
  [['fr-FR', 'en-US', 'zh-CN'], 'en'], [['de-DE', 'zh-HK', 'en'], 'zh-CN'],
  [['fr'], 'en'], [[], 'en'], [undefined, 'en']
]) {
  const { api, host, values } = fixture(languages);
  assert.equal(api.getLanguage(), expected);
  assert.equal(host.document.documentElement.lang, expected);
  assert.equal(api.getPreference(), 'auto');
  assert.equal(values.has('rai_language'), false, 'detection must not become a manual override');
}

for (const [saved, expected] of [['en-US', 'en'], ['zh-CN', 'zh-CN'], ['zh-TW', 'zh-TW'], ['garbage', 'en']]) {
  assert.equal(fixture(['en-GB'], saved).api.getLanguage(), expected);
}
const { api, host, handlers, values } = fixture(['en-US']);
const events = [];
const unsubscribe = api.subscribe((language, preference) => events.push([language, preference]));
api.setPreference('zh-CN');
assert.equal(values.get('rai_language'), 'zh-CN');
host.navigator.languages = ['en-GB'];
handlers.languagechange();
assert.equal(api.getLanguage(), 'zh-CN', 'manual choice wins over browser changes');
api.setPreference('auto');
assert.equal(values.has('rai_language'), false);
assert.equal(api.getLanguage(), 'en');
host.navigator.languages = ['zh-Hant'];
handlers.languagechange();
assert.equal(api.getLanguage(), 'zh-CN');
values.set('rai_language', 'en');
handlers.storage({ key: 'rai_language' });
assert.equal(api.getLanguage(), 'en', 'another tab can change the explicit preference');
unsubscribe();
const count = events.length;
api.setPreference('auto');
assert.equal(events.length, count);
const denied = fixture(['en-US'], undefined, true).api;
assert.equal(denied.getLanguage(), 'en');
denied.setPreference('zh-CN');
assert.equal(denied.getLanguage(), 'zh-CN', 'manual choice still works with storage denied');
denied.setPreference('auto');
assert.equal(denied.getLanguage(), 'en');
assert.equal(createLocale({ navigator: { language: 'zh-CN' } }).getLanguage(), 'zh-CN');
console.log('PASS locale detection, manual/automatic mode, storage failure and cross-tab changes');

(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.RAILocale = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function createLocale(host) {
  'use strict';
  var key = 'rai_language';
  var listeners = [];
  var volatilePreference;

  function normalize(value) {
    var tag = String(value || '').trim().replace(/_/g, '-').toLowerCase();
    if (/^en(?:-|$)/.test(tag)) return 'en';
    if (/^zh(?:-|$)/.test(tag)) {
      return /(?:^|-)(?:tw|hk|mo|hant)(?:-|$)/.test(tag) ? 'zh-TW' : 'zh-CN';
    }
    return null;
  }

  function getPreference() {
    if (volatilePreference !== undefined) return volatilePreference;
    try { return normalize(host.localStorage && host.localStorage.getItem(key)) || 'auto'; }
    catch (_) { return 'auto'; }
  }

  function detect(languages, language) {
    var preferred = (Array.isArray(languages) ? languages : []).concat([language]);
    for (var index = 0; index < preferred.length; index += 1) {
      var normalized = normalize(preferred[index]);
      if (normalized) return normalized === 'en' ? 'en' : 'zh-CN';
    }
    return 'en';
  }

  function getLanguage() {
    var preference = getPreference();
    return preference === 'auto'
      ? detect(host.navigator && host.navigator.languages, host.navigator && host.navigator.language)
      : preference;
  }

  function publish() {
    var language = getLanguage();
    if (host.document && host.document.documentElement) host.document.documentElement.lang = language;
    listeners.slice().forEach(function (listener) { listener(language, getPreference()); });
    return language;
  }

  function setPreference(value) {
    var preference = value === 'auto' ? 'auto' : normalize(value);
    if (!preference) return getLanguage();
    volatilePreference = preference;
    try {
      if (host.localStorage) {
        if (preference === 'auto') host.localStorage.removeItem(key);
        else host.localStorage.setItem(key, preference);
      }
    } catch (_) { /* Preference still works for this page when storage is denied. */ }
    return publish();
  }

  if (host.addEventListener) {
    host.addEventListener('languagechange', function () {
      if (getPreference() === 'auto') publish();
    });
    host.addEventListener('storage', function (event) {
      if (event.key !== key && event.key !== null) return;
      volatilePreference = undefined;
      publish();
    });
  }
  publish();

  return Object.freeze({
    normalize: normalize, detect: detect, getLanguage: getLanguage,
    getPreference: getPreference, setPreference: setPreference,
    subscribe: function (listener) {
      listeners.push(listener);
      return function () {
        var index = listeners.indexOf(listener);
        if (index !== -1) listeners.splice(index, 1);
      };
    }
  });
});

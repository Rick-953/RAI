'use strict';

const https = require('https');
const { EventEmitter } = require('events');
const originalRequest = https.request;

https.request = function request(options, callback) {
  if (options?.hostname !== 'api.tavily.com') return originalRequest.apply(this, arguments);
  const outgoing = new EventEmitter();
  outgoing.setTimeout = () => outgoing;
  outgoing.write = () => true;
  outgoing.destroy = () => {};
  outgoing.end = () => process.nextTick(() => {
    const incoming = new EventEmitter();
    callback(incoming);
    incoming.emit('data', JSON.stringify({ results: Array.from({ length: 6 }, (_, i) => ({
      title: `Fixture source ${i + 1}`, content: `Fixture result ${i + 1}`, url: `https://example.test/${i + 1}`
    })), images: [] }));
    incoming.emit('end');
  });
  return outgoing;
};

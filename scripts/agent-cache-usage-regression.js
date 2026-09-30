'use strict';
const assert=require('node:assert/strict');
const {normalizeUsage}=require('../agent/engine');
assert.deepEqual(normalizeUsage({input_tokens:100,output_tokens:8,input_tokens_details:{cached_tokens:95}}),{prompt_tokens:100,completion_tokens:8,total_tokens:108,prompt_cache_hit_tokens:95});
assert.equal(normalizeUsage({prompt_tokens:100,prompt_tokens_details:{cached_tokens:0}}).prompt_cache_hit_tokens,0);
assert.equal(normalizeUsage({prompt_tokens:100,prompt_cache_hit_tokens:99}).prompt_cache_hit_tokens,99);
for(const value of [-1,101,'bad',Infinity]) assert.equal(normalizeUsage({prompt_tokens:100,prompt_cache_hit_tokens:value}).prompt_cache_hit_tokens,undefined);
assert.equal(normalizeUsage({prompt_tokens:100}).prompt_cache_hit_tokens,undefined);
console.log('PASS: genuine cache usage from both APIs; unreported and invalid counters are not measured zero');

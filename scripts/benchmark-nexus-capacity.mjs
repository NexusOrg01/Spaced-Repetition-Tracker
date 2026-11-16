import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import chunks from '../cloud-chunk-storage.js';
const MiB=1024*1024,levels=[1,27,64,128,225],results=[];
for(const sizeMiB of levels){
 if(global.gc)global.gc();
 const targetBytes=sizeMiB*MiB,prefix='{"payload":"',suffix='"}';
 let serialized=prefix+'x'.repeat(targetBytes-prefix.length-suffix.length)+suffix;
 assert.equal(chunks.utf8ByteLength(serialized),targetBytes);
 const started=performance.now(),ranges=chunks.splitUtf8Ranges(serialized),durationMs=performance.now()-started;
 assert.ok(ranges.length<=chunks.MAX_CHUNKS,`${sizeMiB} MiB fixture must fit configured chunk ceiling`);
 assert.equal(ranges.reduce((n,r)=>n+r.bytes,0),targetBytes);
 assert.ok(ranges.every(r=>r.bytes>0&&r.bytes<=chunks.CHUNK_BYTES));
 assert.equal(ranges[0].start,0);assert.equal(ranges.at(-1).end,serialized.length);
 results.push({sizeMiB,payloadBytes:targetBytes,chunkCount:ranges.length,durationMs:Number(durationMs.toFixed(2)),splitMiBPerSecond:Number((sizeMiB/(durationMs/1000)).toFixed(2)),processRssAfterMiB:Number((process.memoryUsage().rss/MiB).toFixed(2))});
 serialized=null;
}
const overBytes=225*MiB+1,prefix='{"payload":"',suffix='"}';
const oversize=prefix+'x'.repeat(overBytes-prefix.length-suffix.length)+suffix;
const oversizeRanges=chunks.splitUtf8Ranges(oversize);
assert.equal(oversizeRanges.length,chunks.MAX_CHUNKS+1,'one byte beyond 225 MiB must require 901 chunks');
const unicode='🧪'.repeat(400000),unicodeRanges=chunks.splitUtf8Ranges(unicode);
assert.equal(unicodeRanges.reduce((n,r)=>n+r.bytes,0),chunks.utf8ByteLength(unicode),'UTF-8 multi-byte content must have exact chunk byte totals');
assert.ok(unicodeRanges.every(r=>r.bytes<=chunks.CHUNK_BYTES));
const report={generatedAt:new Date().toISOString(),benchmark:'UTF-8 chunk partition envelope only',
 configuration:{chunkBytes:chunks.CHUNK_BYTES,maxChunks:chunks.MAX_CHUNKS,configuredPayloadCeilingBytes:chunks.CHUNK_BYTES*chunks.MAX_CHUNKS,staleChunkRetentionDays:chunks.CLEANUP_AGE_MS/(24*60*60*1000),cleanupBatchRows:chunks.CLEANUP_BATCH_SIZE},
 results,overCap:{payloadBytes:overBytes,requiredChunkCount:oversizeRanges.length,rejectedByConfiguredCeiling:oversizeRanges.length>chunks.MAX_CHUNKS},
 unicode:{payloadUtf8Bytes:chunks.utf8ByteLength(unicode),chunkCount:unicodeRanges.length,verified:true},
 endToEndEvidence:{payloadBytes:26900000,topicCount:77144,reviewHistoryCount:72001,verifiedInSeparateLocalSupabaseLifecycleRun:true},
 limitation:'This measures UTF-8 partitioning in the CI Node.js runner only. It is not an end-to-end 225 MiB browser, WebView, network, Supabase, memory, recovery or supported-device certification.'};
const output=process.env.PHASE35_BENCHMARK_OUTPUT||'/tmp/nexus-phase35-capacity-benchmark.json';
writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
console.log('Benchmark complete; do not interpret the configured 225 MiB ceiling as an end-to-end supported workspace limit.');

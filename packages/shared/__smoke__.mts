import { asyncGreet, greetAll, delay } from './src/index.js';

const t0 = Date.now();
await delay(20);
console.log('delay ok:', Date.now() - t0 >= 20);
console.log(await asyncGreet('Alice', 10));
console.log(await greetAll(['A', 'B'], 10));

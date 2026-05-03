import { recordActual } from "../src/lib/feedback.js";

const r1 = recordActual("4470c35e-ff17-4e86-ad92-105852627020", 0.3, "CP token cost feature");
console.log(`cp: ${r1}`);
const r2 = recordActual("65ab3c22-530b-4fa4-aead-37abafdfac05", 0.3, "TTB for CP token cost");
console.log(`ttb: ${r2}`);
const r3 = recordActual("262c2451-4f9a-41e5-b600-1d328bc3e446", 0.3, "MC for CP token cost");
console.log(`mc: ${r3}`);

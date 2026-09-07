/**
 * Wykrywanie i maskowanie danych osobowych przed wyjściem treści do dostawcy LLM poza EOG.
 * Kontrakt i uzasadnienie granicy: `detect.ts` (detektory) i `policy.ts` (polityka per KB).
 */
export {
  detectPii,
  summarize,
  isValidPesel,
  isValidNip,
  isValidRegon,
  isValidIban,
  isValidIdCard,
  type PiiFinding,
  type PiiReport,
  type PiiType,
} from './detect.js';
export {
  applyPiiPolicy,
  coercePiiPolicy,
  maskFindings,
  PII_POLICIES,
  PII_POLICY_DEFAULT,
  type PiiPolicy,
  type PiiResult,
} from './policy.js';

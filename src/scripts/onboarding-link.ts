// Genera el enlace firmado de alta (o de renovación del token) para un cliente.
// Uso: npm run onboarding-link -- <clientId> <urlBase> [díasValidez] [--renew]
import { createOnboardingLink } from '../onboarding/onboarding';

const args = process.argv.slice(2);
const renew = args.includes('--renew');
const [clientId, baseUrl, days] = args.filter((a) => a !== '--renew');
if (!clientId || !baseUrl) {
  console.error('Uso: npm run onboarding-link -- <clientId> <urlBase> [díasValidez] [--renew]');
  process.exit(1);
}
console.log(createOnboardingLink(baseUrl, clientId, days ? Number(days) : 7, renew ? 'renew' : 'onboard'));

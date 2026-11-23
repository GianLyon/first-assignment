// Online payment providers for the booking engine.
//
//  simulator  Built-in test checkout page (/pay/test.html). Lets you try the full flow before you
//             have a provider account. Never switch it on for real guests: anyone can "pay" with it.
//  pesapal    Pesapal API 3.0: cards and MTN / Airtel mobile money (see pesapal.js).
//
// A provider has:
//   label, configured() -> bool          shown under Finance → Online payments
//   createCheckout(intent, ctx)          -> { checkout_url, provider_ref? }  where to send the guest
//   checkStatus(intent)                  -> { status: 'paid'|'failed'|'reversed'|'pending', amount, currency, method, provider_ref, confirmation }
//                                           (asked after every notification and when the guest comes back; never trust the call itself)
import { pesapal } from './pesapal.js';

export const providers = {
  simulator: {
    label: 'Test checkout (simulator)',
    configured: () => true,
    mode: () => 'test',
    async createCheckout(intent) { return { checkout_url: `/pay/test.html?t=${encodeURIComponent(intent.token)}` }; },
  },
  pesapal,
};

// Online payment providers for the booking engine.
//
//  simulator  Built-in test checkout page (/pay/test.html). Lets you try the full flow before you
//             have a provider account. Never switch it on for real guests: anyone can "pay" with it.
//
// A real provider (e.g. Flutterwave, Pesapal, DPO) plugs in here with two functions:
//   createCheckout(intent, ctx) -> { checkout_url }   send the guest to the provider's page
//   parseWebhook(req)            -> { token, status: 'paid'|'failed', provider_ref, method }   verify the provider's signed callback
// and the provider's callback is pointed at /api/payments/<provider>/webhook.
export const providers = {
  simulator: {
    label: 'Test checkout (simulator)',
    async createCheckout(intent) { return { checkout_url: `/pay/test.html?t=${encodeURIComponent(intent.token)}` }; },
  },
};

// api/stripe-webhook.js
// Receives webhook events from Stripe and syncs subscription state to Supabase.

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Map Stripe price IDs back to our plan names
const PRICE_TO_PLAN = {
  'price_1TP8yACvqGzpeeK5ReLKCig1': 'founder',
  'price_1TP8yvCvqGzpeeK5qiwAdCzf': 'law_firm',
};

// IMPORTANT: Stripe requires the raw request body for signature verification.
// Vercel's default body parser interferes, so we disable it for this route.
module.exports.config = {
  api: { bodyParser: false },
};

// Helper to read raw body from request stream
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const sig = req.headers['stripe-signature'];
  let event;
  try {
    const rawBody = await readRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        // The user just completed the checkout flow
        const session = event.data.object;
        const userId = session.metadata?.supabase_user_id;
        const plan = session.metadata?.plan;
        if (!userId || !plan) {
          console.warn('Missing metadata on checkout.session.completed', session.id);
          break;
        }
        // Fetch the full subscription to get period end
        const subscription = await stripe.subscriptions.retrieve(session.subscription);
        await supabase
          .from('subscriptions')
          .update({
            plan: plan,
            status: subscription.status,
            stripe_customer_id: session.customer,
            stripe_subscription_id: session.subscription,
            current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
          })
          .eq('user_id', userId);
        console.log(`✓ Subscription activated for user ${userId}: ${plan}`);
        break;
      }

      case 'customer.subscription.updated':
      case 'customer.subscription.created': {
        const subscription = event.data.object;
        const userId = subscription.metadata?.supabase_user_id;
        if (!userId) {
          console.warn('Subscription has no supabase_user_id metadata', subscription.id);
          break;
        }
        const priceId = subscription.items.data[0]?.price?.id;
        const plan = PRICE_TO_PLAN[priceId] || 'free';
        await supabase
          .from('subscriptions')
          .update({
            plan: plan,
            status: subscription.status,
            stripe_subscription_id: subscription.id,
            current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
          })
          .eq('user_id', userId);
        console.log(`✓ Subscription updated for user ${userId}: ${plan} (${subscription.status})`);
        break;
      }

      case 'customer.subscription.deleted': {
        // Subscription fully canceled and ended
        const subscription = event.data.object;
        const userId = subscription.metadata?.supabase_user_id;
        if (!userId) break;
        await supabase
          .from('subscriptions')
          .update({
            plan: 'free',
            status: 'canceled',
            stripe_subscription_id: null,
          })
          .eq('user_id', userId);
        console.log(`✓ Subscription canceled for user ${userId}`);
        break;
      }

      case 'invoice.payment_failed': {
        // Mark as past_due so app can show a warning
        const invoice = event.data.object;
        if (invoice.subscription) {
          await supabase
            .from('subscriptions')
            .update({ status: 'past_due' })
            .eq('stripe_subscription_id', invoice.subscription);
          console.log(`⚠ Payment failed for subscription ${invoice.subscription}`);
        }
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    return res.status(500).json({ error: err.message });
  }
};

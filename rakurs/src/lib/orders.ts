import type { Lead } from '@/types';

/**
 * Orders that still stand. A cancelled one is not a purchase this lead made, so a lead
 * whose only order fell through is still asked for money on the next move into the sale
 * stage.
 *
 * Shared rather than duplicated: the lead card and the board both decide whether to open
 * the order form from this count, and two copies of it would drift into two answers.
 */
export const countOrders = (lead: Lead): number =>
  lead.orders.filter((order) => order.status !== 'cancelled').length;

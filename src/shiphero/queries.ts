/**
 * ShipHero Public GraphQL API documents.
 * MERGEABLE_ORDERS and ORDER_MERGE follow https://developer.shiphero.com/flows/merge-orders/ exactly.
 * Fields marked [VERIFY] must be confirmed with `npm run verify-api` (it runs these read-only queries).
 */
const ORDER_FIELDS = `
  id
  legacy_id
  order_number
  partner_order_id
  fulfillment_status
  shop_name
  holds { fraud_hold address_hold shipping_method_hold operator_hold payment_hold client_hold }
  allocations { warehouse_id }                                  # [VERIFY]
  line_items(first: 100) {
    edges { node { id sku quantity quantity_allocated quantity_shipped fulfillment_status } }
  }
`;

export const ORDERS_BY_PARTNER_ID = `
query OrdersByPartnerId($partner_order_id: String) {
  orders(partner_order_id: $partner_order_id) {
    request_id
    complexity
    data(first: 5) { edges { node { ${ORDER_FIELDS} } } }
  }
}`;

export const ORDERS_BY_NUMBER = `
query OrdersByNumber($order_number: String) {
  orders(order_number: $order_number) {
    request_id
    complexity
    data(first: 5) { edges { node { ${ORDER_FIELDS} } } }
  }
}`;

export const ORDER_BY_ID = `
query OrderById($id: String!) {
  order(id: $id) {
    request_id
    complexity
    data {
      ${ORDER_FIELDS}
      merged_orders { order_id is_master }
    }
  }
}`;

// As documented in the ShipHero "Merge Orders" flow.
export const MERGEABLE_ORDERS = `
query MergeableOrdersQuery($first: Int = 15, $after: String, $order_number: String, $first_name: String, $last_name: String, $customer_account_id: String) {
  mergeable_orders {
    request_id
    complexity
    data(first: $first, after: $after, order_number: $order_number, first_name: $first_name, last_name: $last_name, customer_account_id: $customer_account_id) {
      edges { node { id order_number potential_merges { id order_number email } } }
      pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
    }
  }
}`;

// As documented in the ShipHero "Merge Orders" flow.
export const ORDER_MERGE = `
mutation OrderMerge($data: MergeOrdersInput!) {
  order_merge(data: $data) {
    request_id
    complexity
    order {
      id
      order_number
    }
  }
}`;

// Polling fallback when webhooks cannot reach this PC. [VERIFY]
export const SHIPMENTS_FOR_ORDER = `
query ShipmentsForOrder($order_id: String) {
  shipments(order_id: $order_id) {
    request_id
    complexity
    data(first: 10) {
      edges { node {
        id
        order_id
        shipping_labels { tracking_number carrier cost }
        line_items(first: 100) { edges { node { line_item_id quantity line_item { sku } } } }
      } }
    }
  }
}`;

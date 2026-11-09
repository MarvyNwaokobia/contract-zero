-- Supply-order steps settle through the same queue as everything else. The order_*
-- kinds are signed by the server's actor keys; player_order rows record (already
-- verified) steps a player signed in their own wallet, kept as evidence.
ALTER TABLE settlements DROP CONSTRAINT IF EXISTS settlements_kind_check;
ALTER TABLE settlements ADD CONSTRAINT settlements_kind_check CHECK (kind IN (
  'genesis', 'flows', 'raid', 'trade', 'sell', 'operation',
  'order_place', 'order_propose', 'order_fill', 'order_close', 'order_expire', 'player_order'
));

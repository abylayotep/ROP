-- Rename only unchanged default labels; custom funnel names remain owned by the merchant.
UPDATE stages SET name = 'Заказано' WHERE name = 'Счёт отправлен' AND kind = 'awaiting_payment';
--> statement-breakpoint
UPDATE stages SET name = 'Оплачено' WHERE name = 'Продажа' AND kind = 'success';

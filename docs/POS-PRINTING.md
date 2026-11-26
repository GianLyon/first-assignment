# Orders, kitchen and bar screens, bills and receipts

How an order moves from the waiter to the kitchen and back to the guest's bill in Azeli PMS, and what printers to buy.

---

## 1. The flow of one table

```
Waiter (tablet / phone / till)          Kitchen & bar                       Cashier
───────────────────────────────         ──────────────────────────────      ─────────────────────────
Open table T4 · 3 guests · waiter
Add drinks (course 1) and starters
Add mains with "Hold until fired"
Send ──────────────────────────────────► Bar screen: drinks ticket
                                         Kitchen screen: starters ticket
                                         (printed automatically if on)
                                         Ready ──► waiter collects ──► Served
Fire held (mains) ──────────────────────► Kitchen: "Mains" ticket
Print bill (pre-bill, "not a receipt")
                                                                             Pay: cash / card / MoMo /
                                                                             charge to room / split
                                                                             Print receipt
```

- **Courses:** every item has a usual course (drinks and starters, mains, desserts). The waiter can choose the course and tick **Hold** to keep the mains back until the table is ready, then press **Fire held**. The kitchen gets the mains as a separate ticket marked "Mains".
- **Choices:** items with choices (steak: rare / medium / well done; waragi: with ice / no ice) cannot be added until the waiter picks one. The choice prints in bold on the ticket.
- **Notes:** "no onions", "allergy: nuts" go on the line and print as `** no onions **`.
- **Changes after sending:** an item already sent can only be **voided by a manager, with a reason**. The kitchen ticket shows it struck through with VOID, and it appears in the POS voids report.

## 2. Kitchen and bar screens (KDS)

Open **Kitchen & bar screen** on a tablet or TV with a browser, signed in as a kitchen user. It works on any screen; a 10–15" Android tablet on the wall is enough.

- **Tickets oldest first.** Each shows the table or room, waiter, number of guests, course and items. They turn **amber after 15 minutes** and **red after 25**.
- **To make now** at the top: everything waiting, added up across tables (e.g. "6 × Chicken luwombo"), so the cooks batch the work.
- **Ready** tells the waiter to collect. **Served** clears the ticket.
- The screen refreshes every 15 seconds. Tickets of bills closed more than 6 hours ago drop off by themselves.

## 3. Printing

All three slips are laid out for **80 mm thermal paper** (the standard restaurant roll). Every print is counted, and any second print is marked **COPY** and listed in the **Bill & receipt reprints** report.

| Slip | When | What it shows |
|---|---|---|
| **KOT** (kitchen order ticket) | When items are sent, at the kitchen or bar | Station, table or room in large type, waiter, time, course, items, choices and notes |
| **Bill** (pre-bill) | Before payment, for the guest to check | Items, discount, total, VAT included, "This is not a receipt" |
| **Receipt** | After payment | Items, total, VAT, how it was paid, cashier, signature line for room charges, the outlet's footer |

### How to print

**Option A: the screen's own printer (simplest, free).** Connect a thermal printer to the tablet or PC (USB, network or Bluetooth) and make it the default printer. Press **Print** on a ticket, bill or receipt and choose that printer once.

**Option B: print kitchen tickets automatically, with no print window.** On the kitchen and bar computers:
1. Tick **"Print new orders automatically on this screen"** on the Kitchen & bar screen.
2. Start Chrome with silent printing so it prints straight to the default printer, with no dialog. On Windows, edit the Chrome shortcut and add ` --kiosk-printing` at the end of *Target*, then always open Azeli PMS from that shortcut.

Each new order then prints once on that screen's printer. The ticket is counted, so it is never printed twice by accident.

**Option C: a printer in the kitchen and the till in the restaurant.** Put a cheap Android tablet or mini PC next to each printer (one in the kitchen, one at the bar) running the kitchen screen with Option B. Waiters order from any phone or tablet; the tickets print where the food is made.

### What to buy

| Item | Notes | Rough price |
|---|---|---|
| 80 mm thermal receipt printer, USB + LAN (Epson TM-T20/T82 class, Xprinter XP-80 class) | One per station: kitchen, bar, cashier. LAN lets several devices share one printer. | US$60–250 each |
| Android tablet 10" or a mini PC | For the kitchen and bar screens | US$120–250 each |
| Thermal paper rolls 80 × 80 mm | Buy by the box | small |
| Cash drawer (opens from the printer) | At the cashier, optional | US$40–80 |

Sunmi-type Android POS terminals with a built-in printer also work: open Azeli PMS in their browser.

## 4. Bills and payments: what makes it practical

- **Split the bill by items** (each guest pays for what they had) or **split the payment** across up to three methods (part cash, part MoMo).
- **Merge** two tables' bills when guests join up; **move** a bill to another table.
- **Charge to room** puts the bill on the in-house guest's folio, paid at check-out. The receipt has a signature line.
- **Discounts:** percent or amount, always with a reason. Above the outlet's limit (10% unless changed) a manager must give it. Every discount is in the **POS discounts** report.
- **Complimentary** (on the house for a guest) and **house use** (staff meals, tastings): closed by a manager with a reason. No money and no sale are recorded, but the stock and its cost are. Both have their own report.
- **Happy hour:** set the hours on the outlet and a happy-hour price on the item. The price changes on its own, and the **Happy hour sales** report shows what it cost.
- **Shifts:** each cashier opens with a float and closes by counting the drawer. The over or short amount is in the cashier reports.

## 5. Spa and health club

- **Spa:** book a treatment with a therapist and a treatment room. Neither can be double-booked (a couples suite takes two at once). The day board moves each treatment from *booked* to *arrived*, *in treatment* and *done & pay*, either paid there or charged to the room. Retail items and express treatments sell through the Spa outlet's till.
- **Health club:** plans (monthly, quarterly, annual), members with health notes, renewals (paid, or charged to a room), and **check-in at the door by member number or phone**. An expired, unpaid or frozen membership is refused on the spot. Day passes sell at the club's till.

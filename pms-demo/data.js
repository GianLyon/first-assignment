// Sample data for the Hearth & Key PMS demo (fictional property).
// All amounts in Ugandan shillings (UGX), VAT-inclusive.
window.SEED = {
  property: "Lakeview Hotel & Suites",
  startDate: "2026-11-10",

  roomTypes: [
    { code: "STD", name: "Standard Room", rate: 250000 },
    { code: "DLX", name: "Deluxe Room", rate: 350000 },
    { code: "STE", name: "Executive Suite", rate: 550000 },
  ],
  rooms: [
    ...[101,102,103,104,105,106,107,108,109,110].map((n) => ({ no: String(n), type: "STD" })),
    ...[201,202,203,204,205,206,207,208,209,210].map((n) => ({ no: String(n), type: "DLX" })),
    ...[301,302,303,304].map((n) => ({ no: String(n), type: "STE" })),
  ],

  // [guest, phone, type, arriveOffset, nights, room|null, source]
  // offsets are days relative to the business date
  reservations: [
    ["Sarah Namata", "+256 772 100 201", "DLX", -2, 4, "201", "Booking.com"],
    ["James Okello", "+256 701 330 412", "STD", -1, 3, "101", "Direct"],
    ["Li Chen", "+86 138 0013 8000", "STE", -3, 3, "301", "Expedia"],
    ["Peter Smith", "+44 7700 900123", "DLX", -4, 4, "203", "Website"],
    ["Aisha Nakato", "+256 782 554 019", "STD", -1, 2, "103", "Walk-in"],
    ["Brian Ssemwogerere", "+256 755 210 778", "STD", -2, 5, "104", "Direct"],
    ["Emma Johnson", "+1 202 555 0147", "STE", -1, 4, "302", "Airbnb"],
    ["Moses Kato", "+256 776 901 233", "DLX", -1, 1, "205", "Booking.com"],
    ["Fatuma Atim", "+256 703 448 120", "STD", -3, 6, "106", "Website"],
    ["Daniel Byaruhanga", "+256 772 600 315", "DLX", -2, 3, "207", "Corporate"],
    ["Hannah Müller", "+49 151 2345 6789", "DLX", -5, 7, "208", "Expedia"],
    ["Ivan Lubega", "+256 758 332 901", "STD", -1, 2, "108", "Direct"],
    ["Kenji Tanaka", "+81 90 1234 5678", "STE", -2, 4, "303", "Booking.com"],
    ["Ruth Nansubuga", "+256 774 812 556", "DLX", -1, 3, "209", "Website"],
    // arriving today
    ["Michael Brown", "+1 415 555 0199", "DLX", 0, 2, null, "Booking.com"],
    ["Joan Achieng", "+256 789 223 410", "STD", 0, 1, null, "Website"],
    ["Samuel Tumusiime", "+256 700 991 004", "STE", 0, 3, null, "Corporate"],
    ["Patience Auma", "+256 785 404 778", "STD", 0, 2, null, "Expedia"],
    // future
    ["Grace Akello", "+256 772 450 118", "DLX", 1, 3, null, "Website"],
    ["David Mugisha", "+256 701 667 820", "STD", 2, 2, null, "Booking.com"],
    ["Olivia Wright", "+61 412 345 678", "STE", 3, 5, null, "Expedia"],
    ["Paul Kiggundu", "+256 752 118 990", "DLX", 4, 2, null, "Direct"],
  ],
  roomStatus: { "102": "dirty", "105": "dirty", "110": "ooo", "204": "dirty", "206": "vc" },

  outlets: ["Restaurant", "Bar", "Room Service"],
  menu: [
    { id: "m1", outlet: "Restaurant", name: "Rolex (chapati & egg roll)", price: 15000, recipe: [["s_flour", 0.15], ["s_eggs", 2], ["s_veg", 0.1]] },
    { id: "m2", outlet: "Restaurant", name: "Chicken luwombo", price: 45000, recipe: [["s_chicken", 0.4], ["s_veg", 0.2], ["s_rice", 0.2]] },
    { id: "m3", outlet: "Restaurant", name: "Whole grilled tilapia & chips", price: 55000, recipe: [["s_tilapia", 1], ["s_potato", 0.3]] },
    { id: "m4", outlet: "Restaurant", name: "Beef fillet steak", price: 75000, recipe: [["s_beef", 0.3], ["s_potato", 0.2], ["s_veg", 0.1]] },
    { id: "m5", outlet: "Restaurant", name: "Vegetable curry & rice", price: 35000, recipe: [["s_veg", 0.35], ["s_rice", 0.2]] },
    { id: "m6", outlet: "Restaurant", name: "Tropical fruit platter", price: 15000, recipe: [["s_fruit", 0.4]] },
    { id: "m7", outlet: "Bar", name: "Local lager (500ml)", price: 8000, recipe: [["s_lager", 1]] },
    { id: "m8", outlet: "Bar", name: "Glass of house wine", price: 25000, recipe: [["s_wine", 0.2]] },
    { id: "m9", outlet: "Bar", name: "Cocktail of the day", price: 30000, recipe: [["s_spirits", 0.06], ["s_fruit", 0.1]] },
    { id: "m10", outlet: "Bar", name: "Soda", price: 4000, recipe: [["s_soda", 1]] },
    { id: "m11", outlet: "Bar", name: "Fresh passion juice", price: 10000, recipe: [["s_fruit", 0.25]] },
    { id: "m12", outlet: "Bar", name: "Ugandan coffee", price: 8000, recipe: [["s_coffee", 0.02]] },
  ],

  stock: [
    { id: "s_chicken", name: "Chicken", unit: "kg", qty: 18, reorder: 10, cost: 16000, store: "Kitchen" },
    { id: "s_beef", name: "Beef fillet", unit: "kg", qty: 6, reorder: 8, cost: 32000, store: "Kitchen" },
    { id: "s_tilapia", name: "Tilapia (whole)", unit: "pcs", qty: 24, reorder: 15, cost: 14000, store: "Kitchen" },
    { id: "s_rice", name: "Rice", unit: "kg", qty: 40, reorder: 20, cost: 4500, store: "Main store" },
    { id: "s_flour", name: "Wheat flour", unit: "kg", qty: 25, reorder: 10, cost: 4000, store: "Main store" },
    { id: "s_eggs", name: "Eggs", unit: "pcs", qty: 150, reorder: 90, cost: 500, store: "Kitchen" },
    { id: "s_veg", name: "Fresh vegetables", unit: "kg", qty: 30, reorder: 15, cost: 3000, store: "Kitchen" },
    { id: "s_potato", name: "Potatoes", unit: "kg", qty: 35, reorder: 20, cost: 2500, store: "Main store" },
    { id: "s_fruit", name: "Fresh fruit", unit: "kg", qty: 20, reorder: 12, cost: 3500, store: "Kitchen" },
    { id: "s_lager", name: "Local lager", unit: "bottles", qty: 96, reorder: 48, cost: 3500, store: "Bar" },
    { id: "s_wine", name: "House wine", unit: "bottles", qty: 9, reorder: 12, cost: 45000, store: "Bar" },
    { id: "s_spirits", name: "Spirits (assorted)", unit: "litres", qty: 6, reorder: 4, cost: 60000, store: "Bar" },
    { id: "s_soda", name: "Soda", unit: "bottles", qty: 120, reorder: 48, cost: 1500, store: "Bar" },
    { id: "s_coffee", name: "Ugandan coffee beans", unit: "kg", qty: 4, reorder: 3, cost: 30000, store: "Main store" },
    { id: "s_toilet", name: "Toilet rolls", unit: "pcs", qty: 140, reorder: 100, cost: 1200, store: "Housekeeping" },
    { id: "s_soap", name: "Guest soaps", unit: "pcs", qty: 60, reorder: 80, cost: 800, store: "Housekeeping" },
    { id: "s_linen", name: "Bed linen sets", unit: "sets", qty: 70, reorder: 50, cost: 85000, store: "Housekeeping" },
    { id: "s_bulbs", name: "LED bulbs", unit: "pcs", qty: 18, reorder: 10, cost: 9000, store: "Maintenance" },
  ],

  amenities: [
    { id: "a1", name: "Spa massage (60 min)", price: 120000 },
    { id: "a2", name: "Airport transfer (Entebbe)", price: 150000 },
    { id: "a3", name: "Laundry (per bag)", price: 30000 },
    { id: "a4", name: "Kampala city tour (half day)", price: 180000 },
    { id: "a5", name: "Gym day pass", price: 20000 },
    { id: "a6", name: "Pool day pass", price: 30000 },
  ],

  departments: ["Front Office", "Housekeeping", "Kitchen", "Bar", "Restaurant", "Maintenance", "Spa", "Finance", "HR"],

  staff: [
    { id: "e1", name: "Agnes Nalubega", dept: "Front Office", role: "Front Office Manager", salary: 2800000, shift: "Morning" },
    { id: "e2", name: "Robert Kizza", dept: "Front Office", role: "Receptionist", salary: 900000, shift: "Evening" },
    { id: "e3", name: "Prossy Nambi", dept: "Front Office", role: "Night Auditor", salary: 1100000, shift: "Night" },
    { id: "e4", name: "Esther Apio", dept: "Housekeeping", role: "Executive Housekeeper", salary: 1800000, shift: "Morning" },
    { id: "e5", name: "Joseph Wasswa", dept: "Housekeeping", role: "Room Attendant", salary: 650000, shift: "Morning" },
    { id: "e6", name: "Florence Adong", dept: "Housekeeping", role: "Room Attendant", salary: 650000, shift: "Off" },
    { id: "e7", name: "Charles Mutebi", dept: "Kitchen", role: "Head Chef", salary: 3200000, shift: "Morning" },
    { id: "e8", name: "Juliet Kemigisha", dept: "Kitchen", role: "Cook", salary: 900000, shift: "Evening" },
    { id: "e9", name: "Henry Opio", dept: "Restaurant", role: "Waiter", salary: 600000, shift: "Evening" },
    { id: "e10", name: "Brenda Tusiime", dept: "Bar", role: "Bartender", salary: 700000, shift: "Evening" },
    { id: "e11", name: "Simon Ochieng", dept: "Maintenance", role: "Maintenance Technician", salary: 1000000, shift: "Morning" },
    { id: "e12", name: "Mary Nakimuli", dept: "Finance", role: "Accountant", salary: 2500000, shift: "Morning" },
  ],
  leave: [
    { id: "l1", staff: "e5", type: "Annual leave", from: 3, to: 7, status: "Pending" },
    { id: "l2", staff: "e9", type: "Sick leave", from: 0, to: 1, status: "Pending" },
    { id: "l3", staff: "e7", type: "Annual leave", from: 20, to: 27, status: "Approved" },
  ],

  functionRooms: [
    { id: "f1", name: "Victoria Hall", capacity: 250 },
    { id: "f2", name: "Nile Boardroom", capacity: 20 },
    { id: "f3", name: "Garden Terrace", capacity: 150 },
  ],
  eventPackages: [
    { id: "p1", name: "Full-day conference", pp: 85000 },
    { id: "p2", name: "Half-day meeting", pp: 60000 },
    { id: "p3", name: "Wedding reception", pp: 120000 },
    { id: "p4", name: "Cocktail evening", pp: 70000 },
  ],
  events: [
    { name: "Board meeting", client: "Sunrise Investments Ltd", offset: 2, room: "f2", pax: 15, pkg: "p2", depositPct: 100, status: "Confirmed" },
    { name: "Annual sales conference", client: "Kampala Traders Ltd", offset: 5, room: "f1", pax: 120, pkg: "p1", depositPct: 50, status: "Confirmed" },
    { name: "Wedding reception: Nakato & Kato", client: "Nakato family", offset: 12, room: "f3", pax: 150, pkg: "p3", depositPct: 30, status: "Confirmed" },
    { name: "Product launch cocktail", client: "Equator Beverages", offset: 18, room: "f3", pax: 90, pkg: "p4", depositPct: 0, status: "Tentative" },
  ],

  assets: [
    { id: "as1", name: "Standby generator 250 kVA", category: "Power", location: "Generator house", cost: 185000000, bought: "2022-03-01", life: 10, service: 2 },
    { id: "as2", name: "Commercial combi oven", category: "Kitchen", location: "Main kitchen", cost: 42000000, bought: "2023-06-15", life: 8, service: 9 },
    { id: "as3", name: "Industrial washing machine", category: "Laundry", location: "Laundry", cost: 28000000, bought: "2021-09-10", life: 7, service: -3 },
    { id: "as4", name: "Swimming pool pump", category: "Pool", location: "Pool plant room", cost: 9500000, bought: "2024-01-20", life: 6, service: 14 },
    { id: "as5", name: "Air conditioners (24 units)", category: "HVAC", location: "Guest rooms", cost: 96000000, bought: "2022-11-01", life: 8, service: 30 },
    { id: "as6", name: "Airport shuttle van", category: "Vehicle", location: "Car park", cost: 165000000, bought: "2023-02-01", life: 6, service: 6 },
    { id: "as7", name: "Smart TVs (24 units)", category: "Electronics", location: "Guest rooms", cost: 43200000, bought: "2024-05-01", life: 5, service: 90 },
  ],
  workOrders: [
    { asset: "as3", title: "Drum bearing noisy, needs inspection", priority: "High", dept: "Maintenance", status: "Open" },
    { asset: "as5", title: "Room 110 AC not cooling", priority: "High", dept: "Maintenance", status: "In progress" },
    { asset: "as7", title: "Room 204 TV remote replacement", priority: "Low", dept: "Housekeeping", status: "Open" },
  ],

  channels: [
    { name: "Booking.com", commission: 15 },
    { name: "Expedia", commission: 18 },
    { name: "Airbnb", commission: 15 },
    { name: "Google Hotels", commission: 0 },
    { name: "Website booking engine", commission: 0 },
  ],

  schedules: [
    { name: "Daily manager's report", to: "General Manager", when: "Every day, 07:00", on: true },
    { name: "Front office report", to: "Front Office Manager", when: "Every day, 07:00", on: true },
    { name: "F&B sales report", to: "F&B Manager, Head Chef", when: "Every day, 23:30", on: true },
    { name: "Stock & requisitions report", to: "Storekeeper, Finance", when: "Every Monday, 08:00", on: true },
    { name: "Events & banqueting forecast", to: "Events Coordinator", when: "Every Monday, 08:00", on: false },
    { name: "Payroll summary", to: "HR, Finance", when: "Monthly, 25th", on: true },
  ],
};

// Fixed choices used by forms and checked on the server.
export const ROOM_PREFS = ['high_floor', 'low_floor', 'quiet', 'near_lift', 'away_from_lift', 'twin_beds', 'king_bed', 'extra_pillows', 'feather_free', 'non_smoking', 'accessible', 'connecting', 'early_checkin', 'late_checkout'];
export const CONTACT_PREFS = ['whatsapp', 'email', 'sms', 'phone'];
export const AMENITIES = ['wifi', 'ac', 'tv', 'minibar', 'safe', 'kettle', 'desk', 'balcony', 'bathtub', 'rain_shower', 'hairdryer', 'iron', 'kitchenette', 'sofa', 'bathrobes'];
export const ROOM_FEATURES = ['balcony', 'bathtub', 'connecting', 'accessible', 'smoking', 'quiet', 'near_lift', 'corner', 'renovated'];
export const VIEWS = ['garden', 'pool', 'city', 'lake', 'mountain', 'courtyard', 'none'];
export const BEDS = ['king', 'queen', 'double', 'twin', 'single', 'triple', 'family'];
export const MEAL_PLANS = ['room_only', 'bb', 'hb', 'fb', 'ai'];
export const DEPARTMENTS = ['Front office', 'Housekeeping', 'Food & beverage', 'Kitchen', 'Finance', 'Stores', 'Maintenance', 'Sales & marketing', 'Management', 'Security', 'HR'];
/** Keep only known values, without repeats. */
export const pick = (v, list) => [...new Set((Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim()).filter((x) => list.includes(x)))];

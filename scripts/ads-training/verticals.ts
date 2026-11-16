/**
 * Business verticals for the Ads training generator. They come from the owner's own businesses
 * (mobile and emergency tyres, removals, restaurant, barbershop) plus a few local services.
 * Shisha and tobacco are left out on purpose: Google restricts those ads.
 *
 * A fact is something the business owner states. Generated ad text may only use the facts
 * given in the brief, which is what the checker's evidence test enforces.
 */
export interface Fact { id: string; headline: string; sentence: string }
export interface Service { name: string; short: string; slug: string; keywords: string[] }
export interface Vertical {
  id: string; businessNames: string[]; goal: 'calls' | 'bookings' | 'leads';
  services: Service[]; facts: Fact[]; negatives: string[]; ctas: string[];
}

const fact = (id: string, headline: string, sentence: string): Fact => ({ id, headline, sentence });

export const VERTICALS: readonly Vertical[] = [
  {
    id: 'mobile-tyres', goal: 'calls',
    businessNames: ['Duke Street Tyres', 'Tyre Rescue', 'Fit My Tyre', 'Kerbside Tyres', 'Road Ready Tyres', 'City Mobile Tyres', 'Northway Tyres', 'Swift Tyre Fitters'],
    services: [
      { name: 'Mobile Tyre Fitting', short: 'Mobile Tyres', slug: 'mobile', keywords: ['mobile tyre fitting {city}', 'mobile tyre fitter {city}', 'tyres fitted at home {city}', 'mobile tyres {city}', 'tyre fitting at home {city}'] },
      { name: 'Emergency Tyre Call-Out', short: 'Emergency Tyres', slug: 'emergency', keywords: ['emergency tyre fitting {city}', 'emergency tyre call out {city}', 'tyre call out {city}', 'emergency tyre fitter {city}', 'flat tyre help {city}'] },
      { name: '24 Hour Tyre Fitting', short: '24 Hour Tyres', slug: '24-hour', keywords: ['24 hour tyre fitting {city}', '24 hour tyre fitter {city}', 'night tyre fitting {city}', 'late night tyre fitter {city}'] },
      { name: 'Roadside Tyre Replacement', short: 'Roadside Tyres', slug: 'roadside', keywords: ['roadside tyre replacement {city}', 'roadside tyre fitting {city}', 'roadside tyre help {city}', 'flat tyre roadside {city}'] },
      { name: 'Puncture Repair', short: 'Puncture Repair', slug: 'puncture', keywords: ['puncture repair {city}', 'mobile puncture repair {city}', 'tyre puncture repair {city}', 'flat tyre repair {city}'] },
    ],
    facts: [
      fact('open247', 'Open 24/7', 'Open 24/7 with a real fitter on the phone.'),
      fact('eta', 'Call Now For Live ETA', 'Call for a live ETA before a van is dispatched.'),
      fact('response', '30-40 Min Avg Response', 'Average response time is 30-40 minutes.'),
      fact('surcharge', 'No Overnight Surcharge', 'No overnight surcharge on call-outs.'),
      fact('pay', 'Card & Apple Pay', 'Card, contactless and Apple Pay accepted at the kerb.'),
      fact('insured', 'Insured Mobile Fitters', 'All work is done by insured mobile fitters.'),
      fact('stock', 'Fully Stocked Vans', 'Vans carry budget, mid-range and premium tyres.'),
      fact('price55', 'Fitted From £55', 'Fully fitted prices from £55.'),
      fact('price65', 'Fitted From £65', 'Fully fitted prices from £65.'),
      fact('vehicles', 'Cars Vans And 4x4s', 'We fit tyres for cars, vans, 4x4s and run-flats.'),
      fact('quote', 'Get A 60-Second Quote', 'Send your postcode and tyre size for a quote in 60 seconds.'),
      fact('brands', 'All Major Brands', 'All major tyre brands available.'),
    ],
    negatives: ['jobs', 'careers', 'training', 'course', 'salary', 'apprenticeship', 'diy', 'how to', 'youtube', 'second hand', 'part worn', 'bicycle', 'bike', 'tractor', 'wholesale', 'recycling', 'pressure', 'video'],
    ctas: ['Call Now For A Quote', 'Call A Fitter Today', 'Call For Tyre Help'],
  },
  {
    id: 'removals', goal: 'leads',
    businessNames: ['MA Removals', 'Swift Move Removals', 'Clyde Removals', 'Northern Movers', 'Home To Home Removals', 'Safe Hands Movers'],
    services: [
      { name: 'House Removals', short: 'House Removals', slug: 'house', keywords: ['house removals {city}', 'removal company {city}', 'house movers {city}', 'home removals {city}', 'removals {city}'] },
      { name: 'Office Removals', short: 'Office Moves', slug: 'office', keywords: ['office removals {city}', 'office movers {city}', 'business relocation {city}', 'commercial removals {city}'] },
      { name: 'Man And Van', short: 'Man And Van', slug: 'man-van', keywords: ['man and van {city}', 'man with a van {city}', 'small removals {city}', 'van hire with driver {city}'] },
      { name: 'Furniture Removals', short: 'Furniture Moves', slug: 'furniture', keywords: ['furniture removals {city}', 'furniture movers {city}', 'sofa removal {city}', 'furniture delivery {city}'] },
    ],
    facts: [
      fact('insured', 'Fully Insured Movers', 'Every move is carried out by fully insured movers.'),
      fact('quote', 'Get A Free Quote', 'Get a free quote for your move.'),
      fact('packing', 'Packing Service Available', 'Packing materials and a packing service are available.'),
      fact('storage', 'Secure Storage Options', 'Secure storage is available between moves.'),
      fact('weekend', 'Weekend Moves Available', 'Weekend and evening moves are available.'),
      fact('fixed', 'Fixed Price Quotes', 'Fixed price quotes with no hidden fees.'),
      fact('years10', '10 Years Experience', 'Over 10 years experience moving homes and offices.'),
      fact('local', 'Local Family Business', 'A local family business with our own vans.'),
      fact('price40', 'Man And Van From £40', 'Man and van hire from £40 per hour.'),
    ],
    negatives: ['jobs', 'careers', 'salary', 'van hire only', 'self drive', 'diy', 'how to', 'boxes free', 'cheap boxes', 'rubbish', 'skip hire', 'scrap', 'storage units for sale', 'courses'],
    ctas: ['Request A Moving Quote', 'Book Your Move Today', 'Plan Your Move Now'],
  },
  {
    id: 'restaurant', goal: 'bookings',
    businessNames: ['Sultan Restaurant', 'Damascus Grill', 'Cedar House', 'Levant Kitchen', 'Olive Tree Grill', 'Spice Route'],
    services: [
      { name: 'Syrian Restaurant', short: 'Syrian Food', slug: 'syrian', keywords: ['syrian restaurant {city}', 'syrian food {city}', 'arabic restaurant {city}', 'middle eastern restaurant {city}'] },
      { name: 'Halal Restaurant', short: 'Halal Food', slug: 'halal', keywords: ['halal restaurant {city}', 'halal food {city}', 'halal grill {city}', 'halal dinner {city}'] },
      { name: 'Takeaway And Delivery', short: 'Food Delivery', slug: 'delivery', keywords: ['takeaway {city}', 'food delivery {city}', 'shawarma delivery {city}', 'kebab takeaway {city}'] },
      { name: 'Private Dining', short: 'Private Dining', slug: 'private', keywords: ['private dining {city}', 'party venue restaurant {city}', 'group dining {city}', 'function room restaurant {city}'] },
    ],
    facts: [
      fact('halal', '100% Halal Menu', 'Our whole menu is 100% halal.'),
      fact('fresh', 'Fresh Grills Daily', 'Fresh charcoal grills cooked to order every day.'),
      fact('delivery', 'Delivery Available', 'Delivery is available across the city.'),
      fact('groups', 'Groups And Parties Welcome', 'Groups, parties and family events welcome.'),
      fact('online', 'Book A Table Online', 'Book a table online in under a minute.'),
      fact('vegetarian', 'Vegetarian Options', 'Vegetarian and vegan dishes on the menu.'),
      fact('late', 'Open Late Every Day', 'Open late every day of the week.'),
      fact('family', 'Family Recipes', 'Traditional family recipes made in house.'),
    ],
    negatives: ['jobs', 'careers', 'chef jobs', 'recipe', 'recipes', 'how to make', 'menu prices pdf', 'franchise', 'for sale', 'wholesale', 'course', 'youtube'],
    ctas: ['Book Your Table Today', 'Reserve A Table Now', 'Order Online Tonight'],
  },
  {
    id: 'barbershop', goal: 'bookings',
    businessNames: ['Jano Barbershop', 'Istanbul Barbers', 'Sharp Cuts', 'Fade Masters', 'The Gentlemen Barber', 'Classic Blade Barbers'],
    services: [
      { name: 'Barbershop', short: 'Barbers', slug: 'barber', keywords: ['barbers {city}', 'barber shop {city}', 'mens haircut {city}', 'barber near {city}'] },
      { name: 'Turkish Barber', short: 'Turkish Barber', slug: 'turkish', keywords: ['turkish barber {city}', 'turkish barbers {city}', 'hot towel shave {city}', 'turkish shave {city}'] },
      { name: 'Skin Fade Haircut', short: 'Skin Fades', slug: 'fade', keywords: ['skin fade {city}', 'fade haircut {city}', 'mens fade {city}', 'skin fade barber {city}'] },
      { name: 'Beard Trim', short: 'Beard Trims', slug: 'beard', keywords: ['beard trim {city}', 'beard shaping {city}', 'beard barber {city}', 'hot towel beard trim {city}'] },
    ],
    facts: [
      fact('walkins', 'Walk-Ins Welcome', 'Walk-ins welcome, or book ahead online.'),
      fact('online', 'Book Online In Seconds', 'Book your appointment online in seconds.'),
      fact('towel', 'Hot Towel Shaves', 'Traditional hot towel shaves available.'),
      fact('kids', 'Kids Cuts Available', 'Kids haircuts available every day.'),
      fact('price15', 'Haircuts From £15', 'Haircuts from £15.'),
      fact('late', 'Open Late On Weekdays', 'Open late on weekdays for after-work cuts.'),
      fact('experienced', 'Experienced Barbers', 'Experienced barbers trained in modern and classic cuts.'),
      fact('pay', 'Card & Apple Pay', 'Card, contactless and Apple Pay accepted.'),
    ],
    negatives: ['jobs', 'careers', 'barber course', 'training', 'clippers', 'how to', 'diy', 'tutorial', 'salary', 'for sale', 'supplies', 'youtube'],
    ctas: ['Book Your Cut Today', 'Book A Barber Now', 'Reserve Your Chair'],
  },
  {
    id: 'locksmith', goal: 'calls',
    businessNames: ['Key Point Locksmiths', 'Lock Rescue', 'Safe Door Locksmiths', 'Rapid Locks'],
    services: [
      { name: 'Emergency Locksmith', short: 'Locksmith', slug: 'emergency', keywords: ['emergency locksmith {city}', 'locksmith {city}', 'locked out {city}', '24 hour locksmith {city}'] },
      { name: 'Lock Change', short: 'Lock Changes', slug: 'lock-change', keywords: ['lock change {city}', 'change locks {city}', 'new locks fitted {city}', 'lock replacement {city}'] },
      { name: 'UPVC Door Repair', short: 'Door Repairs', slug: 'upvc', keywords: ['upvc door repair {city}', 'door lock repair {city}', 'upvc lock repair {city}', 'door mechanism repair {city}'] },
    ],
    facts: [
      fact('open247', 'Open 24/7', 'Open 24/7 for lockouts and break-ins.'),
      fact('response', '30 Min Avg Response', 'Average response time is 30 minutes.'),
      fact('nodamage', 'Non-Destructive Entry', 'Non-destructive entry wherever possible.'),
      fact('insured', 'Insured Locksmiths', 'All work is done by insured locksmiths.'),
      fact('nocallout', 'No Call-Out Charge', 'No call-out charge, you only pay for the work.'),
      fact('british', 'British Standard Locks', 'We fit British Standard locks.'),
      fact('pay', 'Card & Apple Pay', 'Card, contactless and Apple Pay accepted.'),
    ],
    negatives: ['jobs', 'locksmith course', 'training', 'salary', 'lock picking', 'how to', 'diy', 'tools', 'for sale', 'youtube', 'bike lock', 'padlock'],
    ctas: ['Call A Locksmith Now', 'Call For Fast Help', 'Call Now For A Quote'],
  },
  {
    id: 'plumbing', goal: 'calls',
    businessNames: ['Flow Right Plumbing', 'Clear Pipe Plumbers', 'Home Heat Plumbing', 'Burst Pipe Rescue'],
    services: [
      { name: 'Emergency Plumber', short: 'Plumbers', slug: 'emergency', keywords: ['emergency plumber {city}', 'plumber {city}', 'burst pipe {city}', 'leak repair {city}'] },
      { name: 'Boiler Repair', short: 'Boiler Repair', slug: 'boiler', keywords: ['boiler repair {city}', 'boiler engineer {city}', 'no hot water {city}', 'boiler breakdown {city}'] },
      { name: 'Blocked Drains', short: 'Drain Unblocking', slug: 'drains', keywords: ['blocked drain {city}', 'drain unblocking {city}', 'blocked toilet {city}', 'drain clearance {city}'] },
    ],
    facts: [
      fact('open247', 'Open 24/7', 'Open 24/7 for leaks and breakdowns.'),
      fact('gassafe', 'Gas Safe Engineers', 'Boiler work is done by Gas Safe registered engineers.'),
      fact('fixed', 'Fixed Price Repairs', 'Fixed price repairs agreed before work starts.'),
      fact('response', '60 Min Avg Response', 'Average response time is 60 minutes.'),
      fact('insured', 'Insured Plumbers', 'All work is done by insured plumbers.'),
      fact('pay', 'Card & Apple Pay', 'Card, contactless and Apple Pay accepted.'),
      fact('local', 'Local Family Business', 'A local family business serving the area.'),
    ],
    negatives: ['jobs', 'plumbing course', 'apprenticeship', 'salary', 'how to', 'diy', 'tools', 'for sale', 'wholesale', 'youtube', 'parts', 'manual'],
    ctas: ['Call A Plumber Now', 'Call For Fast Help', 'Call Now For A Quote'],
  },
];

/** Cities are split so validation and test only contain places training never saw. */
export const CITIES = {
  train: ['Glasgow', 'Edinburgh', 'Dundee', 'Stirling', 'Falkirk', 'Paisley', 'Hamilton', 'East Kilbride', 'Motherwell', 'Livingston', 'Kirkcaldy', 'Perth',
    'Cumbernauld', 'Dumfries', 'Greenock', 'Dunfermline', 'Kilmarnock', 'Ayr', 'Irvine', 'Aberdeen', 'Inverness', 'Manchester', 'Birmingham', 'Leeds',
    'Liverpool', 'Sheffield', 'Bristol', 'Newcastle', 'Nottingham', 'Leicester', 'Coventry', 'Bradford', 'Cardiff', 'Belfast', 'Southampton', 'Portsmouth',
    'Plymouth', 'Derby', 'Wolverhampton', 'Stoke', 'Sunderland', 'Reading', 'Luton', 'Preston', 'York', 'Hull', 'Swansea', 'Oxford', 'Cambridge', 'Norwich'],
  validation: ['Elgin', 'Troon', 'Alloa', 'Bolton', 'Exeter', 'Bath'],
  test: ['Arbroath', 'Montrose', 'Peebles', 'Wigan', 'Chester', 'Lincoln', 'Worcester', 'Ipswich'],
} as const;

/** One vertical is never trained on, to measure transfer to an unseen business type. */
export const HELD_OUT_VERTICAL = 'plumbing';

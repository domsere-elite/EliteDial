/**
 * Seed US Area Codes (NPA) into AreaCodeMap
 *
 * Populates all ~330 active US area codes with:
 *   - State (2-letter code)
 *   - Region (geographic cluster for proximity fallback)
 *   - Primary city
 *   - Approximate lat/lng center
 *
 * Run: npx tsx scripts/seed-area-codes.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type AreaCodeEntry = {
    areaCode: string;
    state: string;
    region: string;
    city: string;
    lat: number;
    lng: number;
    overlays?: string;
};

// Region assignments
const REGIONS: Record<string, string> = {
    CT: 'northeast', MA: 'northeast', ME: 'northeast', NH: 'northeast',
    NJ: 'northeast', NY: 'northeast', PA: 'northeast', RI: 'northeast', VT: 'northeast',
    AL: 'southeast', FL: 'southeast', GA: 'southeast', KY: 'southeast',
    MS: 'southeast', NC: 'southeast', SC: 'southeast', TN: 'southeast',
    VA: 'southeast', WV: 'southeast', LA: 'southeast', AR: 'southeast',
    IA: 'midwest', IL: 'midwest', IN: 'midwest', KS: 'midwest',
    MI: 'midwest', MN: 'midwest', MO: 'midwest', ND: 'midwest',
    NE: 'midwest', OH: 'midwest', SD: 'midwest', WI: 'midwest',
    AZ: 'southwest', NM: 'southwest', OK: 'southwest', TX: 'southwest',
    CA: 'west', CO: 'west', HI: 'west', ID: 'west', MT: 'west',
    NV: 'west', OR: 'west', UT: 'west', WA: 'west', WY: 'west', AK: 'west',
    DC: 'dc_metro', DE: 'dc_metro', MD: 'dc_metro',
    PR: 'territories', VI: 'territories', GU: 'territories', AS: 'territories',
};

// Comprehensive US area code database
const AREA_CODES: AreaCodeEntry[] = [
    // Alabama
    { areaCode: '205', state: 'AL', region: 'southeast', city: 'Birmingham', lat: 33.52, lng: -86.81 },
    { areaCode: '251', state: 'AL', region: 'southeast', city: 'Mobile', lat: 30.69, lng: -88.04 },
    { areaCode: '256', state: 'AL', region: 'southeast', city: 'Huntsville', lat: 34.73, lng: -86.59 },
    { areaCode: '334', state: 'AL', region: 'southeast', city: 'Montgomery', lat: 32.38, lng: -86.30 },
    { areaCode: '938', state: 'AL', region: 'southeast', city: 'Huntsville', lat: 34.73, lng: -86.59, overlays: '256' },
    // Alaska
    { areaCode: '907', state: 'AK', region: 'west', city: 'Anchorage', lat: 61.22, lng: -149.90 },
    // Arizona
    { areaCode: '480', state: 'AZ', region: 'southwest', city: 'Mesa', lat: 33.42, lng: -111.74 },
    { areaCode: '520', state: 'AZ', region: 'southwest', city: 'Tucson', lat: 32.22, lng: -110.97 },
    { areaCode: '602', state: 'AZ', region: 'southwest', city: 'Phoenix', lat: 33.45, lng: -112.07 },
    { areaCode: '623', state: 'AZ', region: 'southwest', city: 'Glendale', lat: 33.54, lng: -112.19 },
    { areaCode: '928', state: 'AZ', region: 'southwest', city: 'Flagstaff', lat: 35.20, lng: -111.65 },
    // Arkansas
    { areaCode: '479', state: 'AR', region: 'southeast', city: 'Fort Smith', lat: 35.39, lng: -94.40 },
    { areaCode: '501', state: 'AR', region: 'southeast', city: 'Little Rock', lat: 34.75, lng: -92.29 },
    { areaCode: '870', state: 'AR', region: 'southeast', city: 'Jonesboro', lat: 35.84, lng: -90.70 },
    // California
    { areaCode: '209', state: 'CA', region: 'west', city: 'Stockton', lat: 37.96, lng: -121.29 },
    { areaCode: '213', state: 'CA', region: 'west', city: 'Los Angeles', lat: 34.05, lng: -118.24 },
    { areaCode: '310', state: 'CA', region: 'west', city: 'Santa Monica', lat: 34.02, lng: -118.49 },
    { areaCode: '323', state: 'CA', region: 'west', city: 'Los Angeles', lat: 34.05, lng: -118.24, overlays: '213' },
    { areaCode: '341', state: 'CA', region: 'west', city: 'Oakland', lat: 37.80, lng: -122.27, overlays: '510' },
    { areaCode: '350', state: 'CA', region: 'west', city: 'San Mateo', lat: 37.55, lng: -122.31, overlays: '650' },
    { areaCode: '408', state: 'CA', region: 'west', city: 'San Jose', lat: 37.34, lng: -121.89 },
    { areaCode: '415', state: 'CA', region: 'west', city: 'San Francisco', lat: 37.77, lng: -122.42 },
    { areaCode: '424', state: 'CA', region: 'west', city: 'Los Angeles', lat: 34.02, lng: -118.49, overlays: '310' },
    { areaCode: '442', state: 'CA', region: 'west', city: 'Oceanside', lat: 33.20, lng: -117.38, overlays: '760' },
    { areaCode: '510', state: 'CA', region: 'west', city: 'Oakland', lat: 37.80, lng: -122.27 },
    { areaCode: '530', state: 'CA', region: 'west', city: 'Redding', lat: 40.59, lng: -122.39 },
    { areaCode: '559', state: 'CA', region: 'west', city: 'Fresno', lat: 36.74, lng: -119.77 },
    { areaCode: '562', state: 'CA', region: 'west', city: 'Long Beach', lat: 33.77, lng: -118.19 },
    { areaCode: '619', state: 'CA', region: 'west', city: 'San Diego', lat: 32.72, lng: -117.16 },
    { areaCode: '626', state: 'CA', region: 'west', city: 'Pasadena', lat: 34.15, lng: -118.14 },
    { areaCode: '628', state: 'CA', region: 'west', city: 'San Francisco', lat: 37.77, lng: -122.42, overlays: '415' },
    { areaCode: '650', state: 'CA', region: 'west', city: 'San Mateo', lat: 37.55, lng: -122.31 },
    { areaCode: '657', state: 'CA', region: 'west', city: 'Anaheim', lat: 33.84, lng: -117.86, overlays: '714' },
    { areaCode: '661', state: 'CA', region: 'west', city: 'Bakersfield', lat: 35.37, lng: -119.02 },
    { areaCode: '669', state: 'CA', region: 'west', city: 'San Jose', lat: 37.34, lng: -121.89, overlays: '408' },
    { areaCode: '707', state: 'CA', region: 'west', city: 'Santa Rosa', lat: 38.44, lng: -122.71 },
    { areaCode: '714', state: 'CA', region: 'west', city: 'Anaheim', lat: 33.84, lng: -117.86 },
    { areaCode: '747', state: 'CA', region: 'west', city: 'Burbank', lat: 34.18, lng: -118.31, overlays: '818' },
    { areaCode: '760', state: 'CA', region: 'west', city: 'Oceanside', lat: 33.20, lng: -117.38 },
    { areaCode: '805', state: 'CA', region: 'west', city: 'Santa Barbara', lat: 34.42, lng: -119.70 },
    { areaCode: '818', state: 'CA', region: 'west', city: 'Burbank', lat: 34.18, lng: -118.31 },
    { areaCode: '831', state: 'CA', region: 'west', city: 'Salinas', lat: 36.67, lng: -121.66 },
    { areaCode: '858', state: 'CA', region: 'west', city: 'San Diego', lat: 32.90, lng: -117.20 },
    { areaCode: '909', state: 'CA', region: 'west', city: 'Ontario', lat: 34.07, lng: -117.65 },
    { areaCode: '916', state: 'CA', region: 'west', city: 'Sacramento', lat: 38.58, lng: -121.49 },
    { areaCode: '925', state: 'CA', region: 'west', city: 'Concord', lat: 37.98, lng: -122.03 },
    { areaCode: '949', state: 'CA', region: 'west', city: 'Irvine', lat: 33.68, lng: -117.83 },
    { areaCode: '951', state: 'CA', region: 'west', city: 'Riverside', lat: 33.95, lng: -117.40 },
    // Colorado
    { areaCode: '303', state: 'CO', region: 'west', city: 'Denver', lat: 39.74, lng: -104.99 },
    { areaCode: '719', state: 'CO', region: 'west', city: 'Colorado Springs', lat: 38.83, lng: -104.82 },
    { areaCode: '720', state: 'CO', region: 'west', city: 'Denver', lat: 39.74, lng: -104.99, overlays: '303' },
    { areaCode: '970', state: 'CO', region: 'west', city: 'Fort Collins', lat: 40.59, lng: -105.08 },
    // Connecticut
    { areaCode: '203', state: 'CT', region: 'northeast', city: 'Bridgeport', lat: 41.19, lng: -73.20 },
    { areaCode: '475', state: 'CT', region: 'northeast', city: 'Bridgeport', lat: 41.19, lng: -73.20, overlays: '203' },
    { areaCode: '860', state: 'CT', region: 'northeast', city: 'Hartford', lat: 41.76, lng: -72.68 },
    { areaCode: '959', state: 'CT', region: 'northeast', city: 'Hartford', lat: 41.76, lng: -72.68, overlays: '860' },
    // Delaware
    { areaCode: '302', state: 'DE', region: 'dc_metro', city: 'Wilmington', lat: 39.74, lng: -75.55 },
    // DC
    { areaCode: '202', state: 'DC', region: 'dc_metro', city: 'Washington', lat: 38.90, lng: -77.04 },
    // Florida
    { areaCode: '239', state: 'FL', region: 'southeast', city: 'Fort Myers', lat: 26.64, lng: -81.87 },
    { areaCode: '305', state: 'FL', region: 'southeast', city: 'Miami', lat: 25.76, lng: -80.19 },
    { areaCode: '321', state: 'FL', region: 'southeast', city: 'Orlando', lat: 28.54, lng: -81.38 },
    { areaCode: '352', state: 'FL', region: 'southeast', city: 'Gainesville', lat: 29.65, lng: -82.32 },
    { areaCode: '386', state: 'FL', region: 'southeast', city: 'Daytona Beach', lat: 29.21, lng: -81.02 },
    { areaCode: '407', state: 'FL', region: 'southeast', city: 'Orlando', lat: 28.54, lng: -81.38 },
    { areaCode: '561', state: 'FL', region: 'southeast', city: 'West Palm Beach', lat: 26.72, lng: -80.05 },
    { areaCode: '727', state: 'FL', region: 'southeast', city: 'St. Petersburg', lat: 27.77, lng: -82.64 },
    { areaCode: '754', state: 'FL', region: 'southeast', city: 'Fort Lauderdale', lat: 26.12, lng: -80.14, overlays: '954' },
    { areaCode: '772', state: 'FL', region: 'southeast', city: 'Port St. Lucie', lat: 27.29, lng: -80.35 },
    { areaCode: '786', state: 'FL', region: 'southeast', city: 'Miami', lat: 25.76, lng: -80.19, overlays: '305' },
    { areaCode: '813', state: 'FL', region: 'southeast', city: 'Tampa', lat: 27.95, lng: -82.46 },
    { areaCode: '850', state: 'FL', region: 'southeast', city: 'Tallahassee', lat: 30.44, lng: -84.28 },
    { areaCode: '863', state: 'FL', region: 'southeast', city: 'Lakeland', lat: 28.04, lng: -81.95 },
    { areaCode: '904', state: 'FL', region: 'southeast', city: 'Jacksonville', lat: 30.33, lng: -81.66 },
    { areaCode: '941', state: 'FL', region: 'southeast', city: 'Sarasota', lat: 27.34, lng: -82.53 },
    { areaCode: '954', state: 'FL', region: 'southeast', city: 'Fort Lauderdale', lat: 26.12, lng: -80.14 },
    // Georgia
    { areaCode: '229', state: 'GA', region: 'southeast', city: 'Albany', lat: 31.58, lng: -84.16 },
    { areaCode: '404', state: 'GA', region: 'southeast', city: 'Atlanta', lat: 33.75, lng: -84.39 },
    { areaCode: '470', state: 'GA', region: 'southeast', city: 'Atlanta', lat: 33.75, lng: -84.39, overlays: '404,678,770' },
    { areaCode: '478', state: 'GA', region: 'southeast', city: 'Macon', lat: 32.84, lng: -83.63 },
    { areaCode: '678', state: 'GA', region: 'southeast', city: 'Atlanta', lat: 33.75, lng: -84.39, overlays: '404,770' },
    { areaCode: '706', state: 'GA', region: 'southeast', city: 'Augusta', lat: 33.47, lng: -81.97 },
    { areaCode: '762', state: 'GA', region: 'southeast', city: 'Augusta', lat: 33.47, lng: -81.97, overlays: '706' },
    { areaCode: '770', state: 'GA', region: 'southeast', city: 'Marietta', lat: 33.95, lng: -84.55 },
    { areaCode: '912', state: 'GA', region: 'southeast', city: 'Savannah', lat: 32.08, lng: -81.09 },
    // Hawaii
    { areaCode: '808', state: 'HI', region: 'west', city: 'Honolulu', lat: 21.31, lng: -157.86 },
    // Idaho
    { areaCode: '208', state: 'ID', region: 'west', city: 'Boise', lat: 43.62, lng: -116.21 },
    { areaCode: '986', state: 'ID', region: 'west', city: 'Boise', lat: 43.62, lng: -116.21, overlays: '208' },
    // Illinois
    { areaCode: '217', state: 'IL', region: 'midwest', city: 'Springfield', lat: 39.80, lng: -89.65 },
    { areaCode: '224', state: 'IL', region: 'midwest', city: 'Arlington Heights', lat: 42.08, lng: -87.98, overlays: '847' },
    { areaCode: '309', state: 'IL', region: 'midwest', city: 'Peoria', lat: 40.69, lng: -89.59 },
    { areaCode: '312', state: 'IL', region: 'midwest', city: 'Chicago', lat: 41.88, lng: -87.63 },
    { areaCode: '331', state: 'IL', region: 'midwest', city: 'Aurora', lat: 41.76, lng: -88.32, overlays: '630' },
    { areaCode: '618', state: 'IL', region: 'midwest', city: 'East St. Louis', lat: 38.62, lng: -90.15 },
    { areaCode: '630', state: 'IL', region: 'midwest', city: 'Aurora', lat: 41.76, lng: -88.32 },
    { areaCode: '708', state: 'IL', region: 'midwest', city: 'Cicero', lat: 41.85, lng: -87.75 },
    { areaCode: '773', state: 'IL', region: 'midwest', city: 'Chicago', lat: 41.88, lng: -87.63, overlays: '312' },
    { areaCode: '815', state: 'IL', region: 'midwest', city: 'Rockford', lat: 42.27, lng: -89.09 },
    { areaCode: '847', state: 'IL', region: 'midwest', city: 'Arlington Heights', lat: 42.08, lng: -87.98 },
    { areaCode: '872', state: 'IL', region: 'midwest', city: 'Chicago', lat: 41.88, lng: -87.63, overlays: '312,773' },
    // Indiana
    { areaCode: '219', state: 'IN', region: 'midwest', city: 'Gary', lat: 41.59, lng: -87.35 },
    { areaCode: '260', state: 'IN', region: 'midwest', city: 'Fort Wayne', lat: 41.08, lng: -85.14 },
    { areaCode: '317', state: 'IN', region: 'midwest', city: 'Indianapolis', lat: 39.77, lng: -86.16 },
    { areaCode: '463', state: 'IN', region: 'midwest', city: 'Indianapolis', lat: 39.77, lng: -86.16, overlays: '317' },
    { areaCode: '574', state: 'IN', region: 'midwest', city: 'South Bend', lat: 41.68, lng: -86.25 },
    { areaCode: '765', state: 'IN', region: 'midwest', city: 'Muncie', lat: 40.19, lng: -85.39 },
    { areaCode: '812', state: 'IN', region: 'midwest', city: 'Evansville', lat: 37.97, lng: -87.56 },
    { areaCode: '930', state: 'IN', region: 'midwest', city: 'Evansville', lat: 37.97, lng: -87.56, overlays: '812' },
    // Iowa
    { areaCode: '319', state: 'IA', region: 'midwest', city: 'Cedar Rapids', lat: 41.98, lng: -91.67 },
    { areaCode: '515', state: 'IA', region: 'midwest', city: 'Des Moines', lat: 41.59, lng: -93.62 },
    { areaCode: '563', state: 'IA', region: 'midwest', city: 'Davenport', lat: 41.52, lng: -90.58 },
    { areaCode: '641', state: 'IA', region: 'midwest', city: 'Mason City', lat: 43.15, lng: -93.20 },
    { areaCode: '712', state: 'IA', region: 'midwest', city: 'Sioux City', lat: 42.50, lng: -96.40 },
    // Kansas
    { areaCode: '316', state: 'KS', region: 'midwest', city: 'Wichita', lat: 37.69, lng: -97.34 },
    { areaCode: '620', state: 'KS', region: 'midwest', city: 'Hutchinson', lat: 38.06, lng: -97.93 },
    { areaCode: '785', state: 'KS', region: 'midwest', city: 'Topeka', lat: 39.05, lng: -95.68 },
    { areaCode: '913', state: 'KS', region: 'midwest', city: 'Kansas City', lat: 39.11, lng: -94.63 },
    // Kentucky
    { areaCode: '270', state: 'KY', region: 'southeast', city: 'Bowling Green', lat: 36.99, lng: -86.44 },
    { areaCode: '364', state: 'KY', region: 'southeast', city: 'Bowling Green', lat: 36.99, lng: -86.44, overlays: '270' },
    { areaCode: '502', state: 'KY', region: 'southeast', city: 'Louisville', lat: 38.25, lng: -85.76 },
    { areaCode: '606', state: 'KY', region: 'southeast', city: 'Ashland', lat: 38.47, lng: -82.64 },
    { areaCode: '859', state: 'KY', region: 'southeast', city: 'Lexington', lat: 38.04, lng: -84.50 },
    // Louisiana
    { areaCode: '225', state: 'LA', region: 'southeast', city: 'Baton Rouge', lat: 30.45, lng: -91.19 },
    { areaCode: '318', state: 'LA', region: 'southeast', city: 'Shreveport', lat: 32.53, lng: -93.75 },
    { areaCode: '337', state: 'LA', region: 'southeast', city: 'Lafayette', lat: 30.21, lng: -92.02 },
    { areaCode: '504', state: 'LA', region: 'southeast', city: 'New Orleans', lat: 29.95, lng: -90.07 },
    { areaCode: '985', state: 'LA', region: 'southeast', city: 'Houma', lat: 29.60, lng: -90.72 },
    // Maine
    { areaCode: '207', state: 'ME', region: 'northeast', city: 'Portland', lat: 43.66, lng: -70.26 },
    // Maryland
    { areaCode: '240', state: 'MD', region: 'dc_metro', city: 'Germantown', lat: 39.17, lng: -77.27, overlays: '301' },
    { areaCode: '301', state: 'MD', region: 'dc_metro', city: 'Germantown', lat: 39.17, lng: -77.27 },
    { areaCode: '410', state: 'MD', region: 'dc_metro', city: 'Baltimore', lat: 39.29, lng: -76.61 },
    { areaCode: '443', state: 'MD', region: 'dc_metro', city: 'Baltimore', lat: 39.29, lng: -76.61, overlays: '410' },
    { areaCode: '667', state: 'MD', region: 'dc_metro', city: 'Baltimore', lat: 39.29, lng: -76.61, overlays: '410,443' },
    // Massachusetts
    { areaCode: '339', state: 'MA', region: 'northeast', city: 'Lynn', lat: 42.47, lng: -70.95, overlays: '781' },
    { areaCode: '351', state: 'MA', region: 'northeast', city: 'Lowell', lat: 42.63, lng: -71.32, overlays: '978' },
    { areaCode: '413', state: 'MA', region: 'northeast', city: 'Springfield', lat: 42.10, lng: -72.59 },
    { areaCode: '508', state: 'MA', region: 'northeast', city: 'Worcester', lat: 42.26, lng: -71.80 },
    { areaCode: '617', state: 'MA', region: 'northeast', city: 'Boston', lat: 42.36, lng: -71.06 },
    { areaCode: '774', state: 'MA', region: 'northeast', city: 'Worcester', lat: 42.26, lng: -71.80, overlays: '508' },
    { areaCode: '781', state: 'MA', region: 'northeast', city: 'Lynn', lat: 42.47, lng: -70.95 },
    { areaCode: '857', state: 'MA', region: 'northeast', city: 'Boston', lat: 42.36, lng: -71.06, overlays: '617' },
    { areaCode: '978', state: 'MA', region: 'northeast', city: 'Lowell', lat: 42.63, lng: -71.32 },
    // Michigan
    { areaCode: '231', state: 'MI', region: 'midwest', city: 'Muskegon', lat: 43.23, lng: -86.25 },
    { areaCode: '248', state: 'MI', region: 'midwest', city: 'Troy', lat: 42.61, lng: -83.15 },
    { areaCode: '269', state: 'MI', region: 'midwest', city: 'Kalamazoo', lat: 42.29, lng: -85.59 },
    { areaCode: '313', state: 'MI', region: 'midwest', city: 'Detroit', lat: 42.33, lng: -83.05 },
    { areaCode: '517', state: 'MI', region: 'midwest', city: 'Lansing', lat: 42.73, lng: -84.56 },
    { areaCode: '586', state: 'MI', region: 'midwest', city: 'Warren', lat: 42.49, lng: -83.03 },
    { areaCode: '616', state: 'MI', region: 'midwest', city: 'Grand Rapids', lat: 42.96, lng: -85.66 },
    { areaCode: '734', state: 'MI', region: 'midwest', city: 'Ann Arbor', lat: 42.28, lng: -83.74 },
    { areaCode: '810', state: 'MI', region: 'midwest', city: 'Flint', lat: 43.01, lng: -83.69 },
    { areaCode: '906', state: 'MI', region: 'midwest', city: 'Marquette', lat: 46.55, lng: -87.40 },
    { areaCode: '947', state: 'MI', region: 'midwest', city: 'Troy', lat: 42.61, lng: -83.15, overlays: '248' },
    { areaCode: '989', state: 'MI', region: 'midwest', city: 'Saginaw', lat: 43.42, lng: -83.95 },
    // Minnesota
    { areaCode: '218', state: 'MN', region: 'midwest', city: 'Duluth', lat: 46.79, lng: -92.10 },
    { areaCode: '320', state: 'MN', region: 'midwest', city: 'St. Cloud', lat: 45.56, lng: -94.16 },
    { areaCode: '507', state: 'MN', region: 'midwest', city: 'Rochester', lat: 44.02, lng: -92.47 },
    { areaCode: '612', state: 'MN', region: 'midwest', city: 'Minneapolis', lat: 44.98, lng: -93.27 },
    { areaCode: '651', state: 'MN', region: 'midwest', city: 'St. Paul', lat: 44.94, lng: -93.09 },
    { areaCode: '763', state: 'MN', region: 'midwest', city: 'Brooklyn Park', lat: 45.09, lng: -93.36 },
    { areaCode: '952', state: 'MN', region: 'midwest', city: 'Bloomington', lat: 44.84, lng: -93.30 },
    // Mississippi
    { areaCode: '228', state: 'MS', region: 'southeast', city: 'Gulfport', lat: 30.37, lng: -89.09 },
    { areaCode: '601', state: 'MS', region: 'southeast', city: 'Jackson', lat: 32.30, lng: -90.18 },
    { areaCode: '662', state: 'MS', region: 'southeast', city: 'Tupelo', lat: 34.26, lng: -88.70 },
    { areaCode: '769', state: 'MS', region: 'southeast', city: 'Jackson', lat: 32.30, lng: -90.18, overlays: '601' },
    // Missouri
    { areaCode: '314', state: 'MO', region: 'midwest', city: 'St. Louis', lat: 38.63, lng: -90.20 },
    { areaCode: '417', state: 'MO', region: 'midwest', city: 'Springfield', lat: 37.22, lng: -93.29 },
    { areaCode: '573', state: 'MO', region: 'midwest', city: 'Columbia', lat: 38.95, lng: -92.33 },
    { areaCode: '636', state: 'MO', region: 'midwest', city: 'Chesterfield', lat: 38.66, lng: -90.58 },
    { areaCode: '660', state: 'MO', region: 'midwest', city: 'Sedalia', lat: 38.70, lng: -93.23 },
    { areaCode: '816', state: 'MO', region: 'midwest', city: 'Kansas City', lat: 39.10, lng: -94.58 },
    // Montana
    { areaCode: '406', state: 'MT', region: 'west', city: 'Billings', lat: 45.78, lng: -108.50 },
    // Nebraska
    { areaCode: '308', state: 'NE', region: 'midwest', city: 'Grand Island', lat: 40.92, lng: -98.34 },
    { areaCode: '402', state: 'NE', region: 'midwest', city: 'Omaha', lat: 41.26, lng: -95.94 },
    { areaCode: '531', state: 'NE', region: 'midwest', city: 'Omaha', lat: 41.26, lng: -95.94, overlays: '402' },
    // Nevada
    { areaCode: '702', state: 'NV', region: 'west', city: 'Las Vegas', lat: 36.17, lng: -115.14 },
    { areaCode: '725', state: 'NV', region: 'west', city: 'Las Vegas', lat: 36.17, lng: -115.14, overlays: '702' },
    { areaCode: '775', state: 'NV', region: 'west', city: 'Reno', lat: 39.53, lng: -119.81 },
    // New Hampshire
    { areaCode: '603', state: 'NH', region: 'northeast', city: 'Manchester', lat: 42.99, lng: -71.46 },
    // New Jersey
    { areaCode: '201', state: 'NJ', region: 'northeast', city: 'Jersey City', lat: 40.73, lng: -74.08 },
    { areaCode: '551', state: 'NJ', region: 'northeast', city: 'Jersey City', lat: 40.73, lng: -74.08, overlays: '201' },
    { areaCode: '609', state: 'NJ', region: 'northeast', city: 'Trenton', lat: 40.22, lng: -74.76 },
    { areaCode: '732', state: 'NJ', region: 'northeast', city: 'New Brunswick', lat: 40.49, lng: -74.45 },
    { areaCode: '848', state: 'NJ', region: 'northeast', city: 'New Brunswick', lat: 40.49, lng: -74.45, overlays: '732' },
    { areaCode: '856', state: 'NJ', region: 'northeast', city: 'Camden', lat: 39.93, lng: -75.12 },
    { areaCode: '862', state: 'NJ', region: 'northeast', city: 'Newark', lat: 40.74, lng: -74.17, overlays: '973' },
    { areaCode: '908', state: 'NJ', region: 'northeast', city: 'Elizabeth', lat: 40.66, lng: -74.21 },
    { areaCode: '973', state: 'NJ', region: 'northeast', city: 'Newark', lat: 40.74, lng: -74.17 },
    // New Mexico
    { areaCode: '505', state: 'NM', region: 'southwest', city: 'Albuquerque', lat: 35.08, lng: -106.65 },
    { areaCode: '575', state: 'NM', region: 'southwest', city: 'Las Cruces', lat: 32.35, lng: -106.76 },
    // New York
    { areaCode: '212', state: 'NY', region: 'northeast', city: 'New York', lat: 40.78, lng: -73.97 },
    { areaCode: '315', state: 'NY', region: 'northeast', city: 'Syracuse', lat: 43.05, lng: -76.15 },
    { areaCode: '332', state: 'NY', region: 'northeast', city: 'New York', lat: 40.78, lng: -73.97, overlays: '212,646' },
    { areaCode: '347', state: 'NY', region: 'northeast', city: 'New York', lat: 40.65, lng: -73.95, overlays: '718,929' },
    { areaCode: '516', state: 'NY', region: 'northeast', city: 'Hempstead', lat: 40.71, lng: -73.62 },
    { areaCode: '518', state: 'NY', region: 'northeast', city: 'Albany', lat: 42.65, lng: -73.76 },
    { areaCode: '585', state: 'NY', region: 'northeast', city: 'Rochester', lat: 43.16, lng: -77.61 },
    { areaCode: '607', state: 'NY', region: 'northeast', city: 'Binghamton', lat: 42.10, lng: -75.91 },
    { areaCode: '631', state: 'NY', region: 'northeast', city: 'Huntington', lat: 40.87, lng: -73.43 },
    { areaCode: '646', state: 'NY', region: 'northeast', city: 'New York', lat: 40.78, lng: -73.97, overlays: '212' },
    { areaCode: '680', state: 'NY', region: 'northeast', city: 'Syracuse', lat: 43.05, lng: -76.15, overlays: '315' },
    { areaCode: '716', state: 'NY', region: 'northeast', city: 'Buffalo', lat: 42.89, lng: -78.88 },
    { areaCode: '718', state: 'NY', region: 'northeast', city: 'Brooklyn', lat: 40.65, lng: -73.95 },
    { areaCode: '845', state: 'NY', region: 'northeast', city: 'Poughkeepsie', lat: 41.70, lng: -73.92 },
    { areaCode: '914', state: 'NY', region: 'northeast', city: 'White Plains', lat: 41.03, lng: -73.77 },
    { areaCode: '917', state: 'NY', region: 'northeast', city: 'New York', lat: 40.78, lng: -73.97, overlays: '212,646,332' },
    { areaCode: '929', state: 'NY', region: 'northeast', city: 'Brooklyn', lat: 40.65, lng: -73.95, overlays: '718,347' },
    // North Carolina
    { areaCode: '252', state: 'NC', region: 'southeast', city: 'Greenville', lat: 35.61, lng: -77.37 },
    { areaCode: '336', state: 'NC', region: 'southeast', city: 'Greensboro', lat: 36.07, lng: -79.79 },
    { areaCode: '704', state: 'NC', region: 'southeast', city: 'Charlotte', lat: 35.23, lng: -80.84 },
    { areaCode: '743', state: 'NC', region: 'southeast', city: 'Greensboro', lat: 36.07, lng: -79.79, overlays: '336' },
    { areaCode: '828', state: 'NC', region: 'southeast', city: 'Asheville', lat: 35.60, lng: -82.55 },
    { areaCode: '910', state: 'NC', region: 'southeast', city: 'Fayetteville', lat: 35.05, lng: -78.88 },
    { areaCode: '919', state: 'NC', region: 'southeast', city: 'Raleigh', lat: 35.78, lng: -78.64 },
    { areaCode: '980', state: 'NC', region: 'southeast', city: 'Charlotte', lat: 35.23, lng: -80.84, overlays: '704' },
    { areaCode: '984', state: 'NC', region: 'southeast', city: 'Raleigh', lat: 35.78, lng: -78.64, overlays: '919' },
    // North Dakota
    { areaCode: '701', state: 'ND', region: 'midwest', city: 'Fargo', lat: 46.88, lng: -96.79 },
    // Ohio
    { areaCode: '216', state: 'OH', region: 'midwest', city: 'Cleveland', lat: 41.50, lng: -81.69 },
    { areaCode: '220', state: 'OH', region: 'midwest', city: 'Newark', lat: 40.07, lng: -82.40, overlays: '740' },
    { areaCode: '234', state: 'OH', region: 'midwest', city: 'Akron', lat: 41.08, lng: -81.52, overlays: '330' },
    { areaCode: '330', state: 'OH', region: 'midwest', city: 'Akron', lat: 41.08, lng: -81.52 },
    { areaCode: '380', state: 'OH', region: 'midwest', city: 'Columbus', lat: 39.96, lng: -83.00, overlays: '614' },
    { areaCode: '419', state: 'OH', region: 'midwest', city: 'Toledo', lat: 41.65, lng: -83.54 },
    { areaCode: '440', state: 'OH', region: 'midwest', city: 'Lorain', lat: 41.45, lng: -82.18 },
    { areaCode: '513', state: 'OH', region: 'midwest', city: 'Cincinnati', lat: 39.10, lng: -84.51 },
    { areaCode: '567', state: 'OH', region: 'midwest', city: 'Toledo', lat: 41.65, lng: -83.54, overlays: '419' },
    { areaCode: '614', state: 'OH', region: 'midwest', city: 'Columbus', lat: 39.96, lng: -83.00 },
    { areaCode: '740', state: 'OH', region: 'midwest', city: 'Newark', lat: 40.07, lng: -82.40 },
    { areaCode: '937', state: 'OH', region: 'midwest', city: 'Dayton', lat: 39.76, lng: -84.19 },
    // Oklahoma
    { areaCode: '405', state: 'OK', region: 'southwest', city: 'Oklahoma City', lat: 35.47, lng: -97.52 },
    { areaCode: '539', state: 'OK', region: 'southwest', city: 'Tulsa', lat: 36.15, lng: -95.99, overlays: '918' },
    { areaCode: '580', state: 'OK', region: 'southwest', city: 'Lawton', lat: 34.60, lng: -98.39 },
    { areaCode: '918', state: 'OK', region: 'southwest', city: 'Tulsa', lat: 36.15, lng: -95.99 },
    // Oregon
    { areaCode: '458', state: 'OR', region: 'west', city: 'Eugene', lat: 44.05, lng: -123.09, overlays: '541' },
    { areaCode: '503', state: 'OR', region: 'west', city: 'Portland', lat: 45.52, lng: -122.68 },
    { areaCode: '541', state: 'OR', region: 'west', city: 'Eugene', lat: 44.05, lng: -123.09 },
    { areaCode: '971', state: 'OR', region: 'west', city: 'Portland', lat: 45.52, lng: -122.68, overlays: '503' },
    // Pennsylvania
    { areaCode: '215', state: 'PA', region: 'northeast', city: 'Philadelphia', lat: 39.95, lng: -75.17 },
    { areaCode: '223', state: 'PA', region: 'northeast', city: 'Lancaster', lat: 40.04, lng: -76.31, overlays: '717' },
    { areaCode: '267', state: 'PA', region: 'northeast', city: 'Philadelphia', lat: 39.95, lng: -75.17, overlays: '215' },
    { areaCode: '272', state: 'PA', region: 'northeast', city: 'Scranton', lat: 41.41, lng: -75.66, overlays: '570' },
    { areaCode: '412', state: 'PA', region: 'northeast', city: 'Pittsburgh', lat: 40.44, lng: -79.99 },
    { areaCode: '484', state: 'PA', region: 'northeast', city: 'Allentown', lat: 40.60, lng: -75.49, overlays: '610' },
    { areaCode: '570', state: 'PA', region: 'northeast', city: 'Scranton', lat: 41.41, lng: -75.66 },
    { areaCode: '610', state: 'PA', region: 'northeast', city: 'Allentown', lat: 40.60, lng: -75.49 },
    { areaCode: '717', state: 'PA', region: 'northeast', city: 'Lancaster', lat: 40.04, lng: -76.31 },
    { areaCode: '724', state: 'PA', region: 'northeast', city: 'New Castle', lat: 41.00, lng: -80.35 },
    { areaCode: '814', state: 'PA', region: 'northeast', city: 'Erie', lat: 42.13, lng: -80.09 },
    { areaCode: '878', state: 'PA', region: 'northeast', city: 'Pittsburgh', lat: 40.44, lng: -79.99, overlays: '412' },
    // Rhode Island
    { areaCode: '401', state: 'RI', region: 'northeast', city: 'Providence', lat: 41.82, lng: -71.41 },
    // South Carolina
    { areaCode: '803', state: 'SC', region: 'southeast', city: 'Columbia', lat: 34.00, lng: -81.04 },
    { areaCode: '843', state: 'SC', region: 'southeast', city: 'Charleston', lat: 32.78, lng: -79.93 },
    { areaCode: '854', state: 'SC', region: 'southeast', city: 'Charleston', lat: 32.78, lng: -79.93, overlays: '843' },
    { areaCode: '864', state: 'SC', region: 'southeast', city: 'Greenville', lat: 34.85, lng: -82.40 },
    // South Dakota
    { areaCode: '605', state: 'SD', region: 'midwest', city: 'Sioux Falls', lat: 43.55, lng: -96.73 },
    // Tennessee
    { areaCode: '423', state: 'TN', region: 'southeast', city: 'Chattanooga', lat: 35.05, lng: -85.31 },
    { areaCode: '615', state: 'TN', region: 'southeast', city: 'Nashville', lat: 36.16, lng: -86.78 },
    { areaCode: '629', state: 'TN', region: 'southeast', city: 'Nashville', lat: 36.16, lng: -86.78, overlays: '615' },
    { areaCode: '731', state: 'TN', region: 'southeast', city: 'Jackson', lat: 35.61, lng: -88.81 },
    { areaCode: '865', state: 'TN', region: 'southeast', city: 'Knoxville', lat: 35.96, lng: -83.92 },
    { areaCode: '901', state: 'TN', region: 'southeast', city: 'Memphis', lat: 35.15, lng: -90.05 },
    { areaCode: '931', state: 'TN', region: 'southeast', city: 'Clarksville', lat: 36.53, lng: -87.36 },
    // Texas
    { areaCode: '210', state: 'TX', region: 'southwest', city: 'San Antonio', lat: 29.42, lng: -98.49 },
    { areaCode: '214', state: 'TX', region: 'southwest', city: 'Dallas', lat: 32.78, lng: -96.80 },
    { areaCode: '254', state: 'TX', region: 'southwest', city: 'Waco', lat: 31.55, lng: -97.15 },
    { areaCode: '281', state: 'TX', region: 'southwest', city: 'Houston', lat: 29.76, lng: -95.37 },
    { areaCode: '325', state: 'TX', region: 'southwest', city: 'Abilene', lat: 32.45, lng: -99.73 },
    { areaCode: '346', state: 'TX', region: 'southwest', city: 'Houston', lat: 29.76, lng: -95.37, overlays: '713,281,832' },
    { areaCode: '361', state: 'TX', region: 'southwest', city: 'Corpus Christi', lat: 27.80, lng: -97.40 },
    { areaCode: '409', state: 'TX', region: 'southwest', city: 'Beaumont', lat: 30.09, lng: -94.10 },
    { areaCode: '430', state: 'TX', region: 'southwest', city: 'Tyler', lat: 32.35, lng: -95.30, overlays: '903' },
    { areaCode: '432', state: 'TX', region: 'southwest', city: 'Midland', lat: 31.99, lng: -102.08 },
    { areaCode: '469', state: 'TX', region: 'southwest', city: 'Dallas', lat: 32.78, lng: -96.80, overlays: '214,972' },
    { areaCode: '512', state: 'TX', region: 'southwest', city: 'Austin', lat: 30.27, lng: -97.74 },
    { areaCode: '682', state: 'TX', region: 'southwest', city: 'Fort Worth', lat: 32.76, lng: -97.33, overlays: '817' },
    { areaCode: '713', state: 'TX', region: 'southwest', city: 'Houston', lat: 29.76, lng: -95.37 },
    { areaCode: '726', state: 'TX', region: 'southwest', city: 'San Antonio', lat: 29.42, lng: -98.49, overlays: '210' },
    { areaCode: '737', state: 'TX', region: 'southwest', city: 'Austin', lat: 30.27, lng: -97.74, overlays: '512' },
    { areaCode: '806', state: 'TX', region: 'southwest', city: 'Lubbock', lat: 33.57, lng: -101.85 },
    { areaCode: '817', state: 'TX', region: 'southwest', city: 'Fort Worth', lat: 32.76, lng: -97.33 },
    { areaCode: '830', state: 'TX', region: 'southwest', city: 'New Braunfels', lat: 29.70, lng: -98.12 },
    { areaCode: '832', state: 'TX', region: 'southwest', city: 'Houston', lat: 29.76, lng: -95.37, overlays: '713,281' },
    { areaCode: '903', state: 'TX', region: 'southwest', city: 'Tyler', lat: 32.35, lng: -95.30 },
    { areaCode: '915', state: 'TX', region: 'southwest', city: 'El Paso', lat: 31.76, lng: -106.49 },
    { areaCode: '936', state: 'TX', region: 'southwest', city: 'Conroe', lat: 30.31, lng: -95.46 },
    { areaCode: '940', state: 'TX', region: 'southwest', city: 'Denton', lat: 33.21, lng: -97.13 },
    { areaCode: '956', state: 'TX', region: 'southwest', city: 'Laredo', lat: 27.51, lng: -99.51 },
    { areaCode: '972', state: 'TX', region: 'southwest', city: 'Dallas', lat: 32.78, lng: -96.80 },
    { areaCode: '979', state: 'TX', region: 'southwest', city: 'College Station', lat: 30.63, lng: -96.33 },
    // Utah
    { areaCode: '385', state: 'UT', region: 'west', city: 'Salt Lake City', lat: 40.76, lng: -111.89, overlays: '801' },
    { areaCode: '435', state: 'UT', region: 'west', city: 'St. George', lat: 37.10, lng: -113.58 },
    { areaCode: '801', state: 'UT', region: 'west', city: 'Salt Lake City', lat: 40.76, lng: -111.89 },
    // Vermont
    { areaCode: '802', state: 'VT', region: 'northeast', city: 'Burlington', lat: 44.48, lng: -73.21 },
    // Virginia
    { areaCode: '276', state: 'VA', region: 'southeast', city: 'Bristol', lat: 36.60, lng: -82.19 },
    { areaCode: '434', state: 'VA', region: 'southeast', city: 'Lynchburg', lat: 37.41, lng: -79.14 },
    { areaCode: '540', state: 'VA', region: 'southeast', city: 'Roanoke', lat: 37.27, lng: -79.94 },
    { areaCode: '571', state: 'VA', region: 'southeast', city: 'Arlington', lat: 38.88, lng: -77.10, overlays: '703' },
    { areaCode: '703', state: 'VA', region: 'southeast', city: 'Arlington', lat: 38.88, lng: -77.10 },
    { areaCode: '757', state: 'VA', region: 'southeast', city: 'Norfolk', lat: 36.85, lng: -76.29 },
    { areaCode: '804', state: 'VA', region: 'southeast', city: 'Richmond', lat: 37.54, lng: -77.44 },
    // Washington
    { areaCode: '206', state: 'WA', region: 'west', city: 'Seattle', lat: 47.61, lng: -122.33 },
    { areaCode: '253', state: 'WA', region: 'west', city: 'Tacoma', lat: 47.25, lng: -122.44 },
    { areaCode: '360', state: 'WA', region: 'west', city: 'Olympia', lat: 47.04, lng: -122.90 },
    { areaCode: '425', state: 'WA', region: 'west', city: 'Bellevue', lat: 47.61, lng: -122.20 },
    { areaCode: '509', state: 'WA', region: 'west', city: 'Spokane', lat: 47.66, lng: -117.43 },
    { areaCode: '564', state: 'WA', region: 'west', city: 'Olympia', lat: 47.04, lng: -122.90, overlays: '360' },
    // West Virginia
    { areaCode: '304', state: 'WV', region: 'southeast', city: 'Charleston', lat: 38.35, lng: -81.63 },
    { areaCode: '681', state: 'WV', region: 'southeast', city: 'Charleston', lat: 38.35, lng: -81.63, overlays: '304' },
    // Wisconsin
    { areaCode: '262', state: 'WI', region: 'midwest', city: 'Waukesha', lat: 43.01, lng: -88.23 },
    { areaCode: '414', state: 'WI', region: 'midwest', city: 'Milwaukee', lat: 43.04, lng: -87.91 },
    { areaCode: '534', state: 'WI', region: 'midwest', city: 'Eau Claire', lat: 44.81, lng: -91.50, overlays: '715' },
    { areaCode: '608', state: 'WI', region: 'midwest', city: 'Madison', lat: 43.07, lng: -89.40 },
    { areaCode: '715', state: 'WI', region: 'midwest', city: 'Eau Claire', lat: 44.81, lng: -91.50 },
    { areaCode: '920', state: 'WI', region: 'midwest', city: 'Green Bay', lat: 44.51, lng: -88.02 },
    // Wyoming
    { areaCode: '307', state: 'WY', region: 'west', city: 'Cheyenne', lat: 41.14, lng: -104.82 },
    // Puerto Rico
    { areaCode: '787', state: 'PR', region: 'territories', city: 'San Juan', lat: 18.47, lng: -66.11 },
    { areaCode: '939', state: 'PR', region: 'territories', city: 'San Juan', lat: 18.47, lng: -66.11, overlays: '787' },
    // US Virgin Islands
    { areaCode: '340', state: 'VI', region: 'territories', city: 'Charlotte Amalie', lat: 18.34, lng: -64.93 },
    // Guam
    { areaCode: '671', state: 'GU', region: 'territories', city: 'Hagatna', lat: 13.47, lng: 144.75 },
];

async function main() {
    console.log(`Seeding ${AREA_CODES.length} area codes...`);

    let created = 0;
    let updated = 0;

    for (const entry of AREA_CODES) {
        const existing = await prisma.areaCodeMap.findUnique({
            where: { areaCode: entry.areaCode },
        });

        if (existing) {
            await prisma.areaCodeMap.update({
                where: { areaCode: entry.areaCode },
                data: {
                    state: entry.state,
                    region: entry.region,
                    city: entry.city,
                    latitude: entry.lat,
                    longitude: entry.lng,
                    overlays: entry.overlays || null,
                    updatedAt: new Date(),
                },
            });
            updated++;
        } else {
            await prisma.areaCodeMap.create({
                data: {
                    areaCode: entry.areaCode,
                    state: entry.state,
                    region: entry.region,
                    city: entry.city,
                    latitude: entry.lat,
                    longitude: entry.lng,
                    overlays: entry.overlays || null,
                },
            });
            created++;
        }
    }

    console.log(`✅ Area code seeding complete: ${created} created, ${updated} updated`);
}

main()
    .catch((error) => {
        console.error('Area code seeding failed:', error);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });

/** Shared constants. Kept out of `fetch.mjs` so importing them cannot start a download. */
export const LAYER =
  'https://tiles.arcgis.com/tiles/sFnw0xNflSi8J0uh/arcgis/rest/services/Bos3d_Existing_MP/SceneServer/layers/0';
/** Northeastern hero envelope plus margin, in degrees. */
export const BBOX = { w: -71.0985, e: -71.0790, s: 42.3310, n: 42.3470 };
/** Only what a height question needs. */
export const WANT = ['OBJECTID', 'Name', 'Status', 'QA_Flag', 'Centr_Lat', 'Centr_Lon',
  'Gnd_El_Ft', 'Height_Ft', 'Model_LOD', 'Parcel_ID', 'StructType', 'Survey_Dt',
  'Z_Max_Ft', 'Z_MIn_Ft'];

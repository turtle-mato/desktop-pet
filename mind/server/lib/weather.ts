// Morning-only network location. Never store IP, coordinates or screenshots.
export interface LocalWeather { ok: boolean; date: string; city?: string; text: string }
const cache = new Map<string, { at: number; value: LocalWeather }>();
const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
const clean = (v: unknown) => typeof v === "string" ? v.replace(/[\r\n<>]/g," ").trim().slice(0,60) : "";
function condition(code: number): string {
  if (code === 0) return "晴";
  if ([1,2,3].includes(code)) return "多云";
  if ([45,48].includes(code)) return "有雾";
  if ([51,53,55,56,57].includes(code)) return "有毛毛雨";
  if ([61,63,65,66,67,80,81,82].includes(code)) return "有雨";
  if ([71,73,75,77,85,86].includes(code)) return "有雪";
  if ([95,96,99].includes(code)) return "可能有雷雨";
  return "天气状况暂不明确";
}
export async function localWeather(at = new Date()): Promise<LocalWeather> {
  const date = localDate(at), old = cache.get(date);
  if (old && Date.now() - old.at < (old.value.ok ? 12*3600_000 : 30*60_000)) return old.value;
  let value: LocalWeather = {ok:false,date,text:"没有查到可靠的当地天气；不要编城市、温度、降雨或假称已定位。可以简短说天气没查到，再聊今天的安排。"};
  try {
    const get = async (url: string) => {
      const r = await fetch(url, {signal:AbortSignal.timeout(6000)});
      if (!r.ok) throw Error("weather unavailable");
      return r.json();
    };
    // Approximate city from the requesting network, not Windows precise location.
    const geo = await get("https://ipwho.is/?lang=zh-CN");
    const city = clean(geo.city), region = clean(geo.region), country = clean(geo.country);
    const lat = geo.latitude, lon = geo.longitude;
    if (geo.success !== true || !city || typeof lat !== "number" || typeof lon !== "number" ||
      !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat)>90 || Math.abs(lon)>180) throw Error("location unavailable");
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.search = new URLSearchParams({latitude:String(lat),longitude:String(lon),timezone:"auto",forecast_days:"1",
      daily:"weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max"}).toString();
    const forecast = await get(String(url)), d = forecast.daily;
    const lo = d?.temperature_2m_min?.[0], hi = d?.temperature_2m_max?.[0], code = d?.weather_code?.[0], rain = d?.precipitation_probability_max?.[0];
    if (d?.time?.[0] !== date || typeof lo !== "number" || typeof hi !== "number" || !Number.isFinite(lo) || !Number.isFinite(hi) ||
      lo < -90 || hi > 65 || lo > hi || typeof code !== "number") throw Error("stale or invalid forecast");
    const place = [country,region,city].filter((x,i,a)=>x && a.indexOf(x)===i).join(" ");
    value = {ok:true,date,city,text:`${date}，网络粗定位：${place}（代理/VPN可能偏移，不保证是实际所在地）；当日预报：${condition(code)}，${Math.round(lo)}～${Math.round(hi)}℃${typeof rain === "number" && Number.isFinite(rain) && rain>=0 && rain<=100 ? `，最高降水概率${Math.round(rain)}%` : ""}。来源：ipwho.is城市定位、Open-Meteo天气预报。提醒时带城市名，用“网络定位在…”或“定位如果没跑偏…”表达不确定性。只给预报支持的带伞/添衣建议，不编空气质量、预警或实况。`};
  } catch { /* No network details or coordinates in logs. */ }
  cache.clear(); cache.set(date,{at:Date.now(),value});
  return value;
}

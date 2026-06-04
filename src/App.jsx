import { Component, useState, useEffect, useMemo, useRef, useCallback } from 'react';
import * as d3 from 'd3';
import './App.css';

const NAVER_MAP_CLIENT_ID = (import.meta.env.VITE_NAVER_MAP_KEY || import.meta.env.MAP_API || '').trim();
const NAVER_MAP_RUNTIME_ENABLED = ['1', 'true', 'yes'].includes(
    String(import.meta.env.VITE_NAVER_MAP_RUNTIME_ENABLED || import.meta.env.MAP_NAVER_RUNTIME || '').toLowerCase()
);
const CITY_DATA_API_KEY = (import.meta.env.VITE_CITY_DATA_API_KEY || import.meta.env.CITY_DATA_API_KEY || '').trim();
const NAVER_MAP_SCRIPT_ID = 'naver-map-js-sdk';
const NAVER_MAP_PARAM_CANDIDATES = ['ncpKeyId', 'ncpClientId'];

const cleanStationName = (name = '') => name.replace(/\(.*\)/g, '').replace(/역$/, '').trim();
const hours = Array.from({ length: 24 }, (_, hour) => hour);
const formatNumber = (n) => new Intl.NumberFormat().format(Math.round(Number(n) || 0));
const hourLabel = (hour) => `${String(hour).padStart(2, '0')}:00`;

const TYPE_LABELS = {
    Business: 'Morning Inflow',
    Residential: 'Morning Outflow',
    Mixed: 'Mixed Flow',
    'Commercial Night': 'Commercial Night',
};

const TYPE_COLORS = {
    Business: '#e67e22',
    Residential: '#2fbf71',
    Mixed: '#8d99a6',
    'Commercial Night': '#d9467c',
};

const DRY_WEATHER_EVENT = {
    rainMm: 0,
    snowCm: 0,
    newSnowCm: 0,
    phenomenonCode: '',
    weatherImpact: 'Dry',
};

const WEATHER_STYLES = {
    Dry: { label: 'Dry', icon: 'Clear', color: '#8d99a6' },
    Rain: { label: 'Rain', icon: 'Rain', color: '#2f80ed' },
    'Heavy Rain': { label: 'Heavy Rain', icon: 'Heavy Rain', color: '#0f4c81' },
    Snow: { label: 'Snow', icon: 'Snow', color: '#7fbfff' },
    'Snow Accumulation': { label: 'Snow Accumulation', icon: 'Snow Build-up', color: '#5a8dee' },
};

const getStationTypeLabel = (type) => TYPE_LABELS[type] || TYPE_LABELS.Mixed;
const getWeatherStyle = (event = DRY_WEATHER_EVENT) => WEATHER_STYLES[event.weatherImpact] || WEATHER_STYLES.Dry;

const buildNaverMapsScriptSrc = (clientId, paramName, callbackName) => {
    const params = new URLSearchParams({ [paramName]: clientId });
    if (callbackName) params.set('callback', callbackName);
    return `https://oapi.map.naver.com/openapi/v3/maps.js?${params.toString()}`;
};

const waitForNaverMaps = (timeoutMs = 7000) => new Promise((resolve, reject) => {
    const startedAt = Date.now();

    const check = () => {
        if (window.naver?.maps?.Map) {
            resolve(window.naver.maps);
            return;
        }

        if (Date.now() - startedAt > timeoutMs) {
            reject(new Error('NAVER Maps SDK did not initialize.'));
            return;
        }

        window.setTimeout(check, 80);
    };

    check();
});

const loadNaverMapsScript = (clientId, paramName) => {
    if (window.naver?.maps?.Map) return Promise.resolve(window.naver.maps);
    if (window.__naverMapsLoader) return window.__naverMapsLoader;

    window.__naverMapsLoader = new Promise((resolve, reject) => {
        const existingScript = document.getElementById(NAVER_MAP_SCRIPT_ID);
        if (existingScript) {
            if (window.naver?.maps?.Map) {
                resolve(window.naver.maps);
                return;
            }
            existingScript.remove();
        }

        const script = document.createElement('script');
        let settled = false;
        const callbackName = `__naverMapsReady_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const fail = (error) => {
            if (settled) return;
            settled = true;
            window.__naverMapsLoader = null;
            window.removeEventListener('error', handleScriptError, true);
            delete window[callbackName];
            script.remove();
            reject(error);
        };
        const succeed = () => {
            if (settled) return;
            waitForNaverMaps().then((maps) => {
                if (settled) return;
                settled = true;
                window.removeEventListener('error', handleScriptError, true);
                delete window[callbackName];
                resolve(maps);
            }).catch(fail);
        };
        function handleScriptError(event) {
            const source = `${event.filename || ''} ${event.message || ''}`;
            if (source.includes('oapi.map.naver.com/openapi/v3/maps.js') || source.includes('capitalize')) {
                event.preventDefault();
                fail(new Error('NAVER Maps SDK authentication failed.'));
            }
        }

        window.addEventListener('error', handleScriptError, true);
        window[callbackName] = succeed;
        script.id = NAVER_MAP_SCRIPT_ID;
        script.dataset.paramName = paramName;
        script.src = buildNaverMapsScriptSrc(clientId, paramName, callbackName);
        script.async = true;
        script.onload = succeed;
        script.onerror = () => fail(new Error('Failed to load NAVER Maps SDK.'));
        document.head.appendChild(script);
    });

    return window.__naverMapsLoader;
};

const preflightNaverMapsScriptParam = (clientId, paramName) => new Promise((resolve) => {
    const requestId = `naver-preflight-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const iframe = document.createElement('iframe');
    const timer = window.setTimeout(() => finish(false), 8000);

    function finish(ok) {
        window.clearTimeout(timer);
        window.removeEventListener('message', handleMessage);
        iframe.remove();
        resolve(ok);
    }

    function handleMessage(event) {
        if (event.source !== iframe.contentWindow || event.data?.requestId !== requestId) return;
        finish(event.data.status === 'ready');
    }

    window.addEventListener('message', handleMessage);
    iframe.style.display = 'none';
    iframe.sandbox = 'allow-scripts allow-same-origin';
    document.body.appendChild(iframe);

    const callbackName = `naverPreflightReady_${requestId.replace(/-/g, '_')}`;
    const src = buildNaverMapsScriptSrc(clientId, paramName, callbackName);
    const doc = iframe.contentDocument;
    doc.open();
    doc.write(`
        <!doctype html>
        <html>
            <body>
                <script>
                    var requestId = ${JSON.stringify(requestId)};
                    function report(status) {
                        parent.postMessage({ requestId: requestId, status: status }, '*');
                    }
                    window.onerror = function () {
                        report('failed');
                        return true;
                    };
                    window[${JSON.stringify(callbackName)}] = function () {
                        var startedAt = Date.now();
                        function check() {
                            if (window.naver && window.naver.maps && window.naver.maps.Map) {
                                report('ready');
                                return;
                            }
                            if (Date.now() - startedAt > 7000) {
                                report('failed');
                                return;
                            }
                            setTimeout(check, 80);
                        }
                        check();
                    };
                </script>
                <script src="${src}" onerror="report('failed')"></script>
            </body>
        </html>
    `);
    doc.close();
});

const preflightNaverMapsScript = async (clientId) => {
    for (const paramName of NAVER_MAP_PARAM_CANDIDATES) {
        if (await preflightNaverMapsScriptParam(clientId, paramName)) return paramName;
    }
    return '';
};

function getNaverMarkerIcon({ station, style, magnitude, selected, hovered, labelled }) {
    const size = Math.round((selected ? 24 : hovered ? 20 : 12) + magnitude * (selected ? 12 : 10));
    const label = labelled || selected || hovered
        ? `<span class="naver-station-label">${station.name}</span>`
        : '';
    const activeClass = selected ? ' is-selected' : hovered ? ' is-hovered' : '';
    const subtleClass = style.opacity < 0.5 ? ' is-muted' : '';

    return {
        content: `
            <div class="naver-station-marker${activeClass}${subtleClass}" style="--marker-color:${style.color};--marker-size:${size}px;">
                <span class="marker-glow"></span>
                <span class="marker-ring"></span>
                <span class="marker-core"></span>
                ${label}
            </div>
        `,
        anchor: new window.naver.maps.Point(size / 2, size / 2),
    };
}

function NaverMapGate(props) {
    const [status, setStatus] = useState(NAVER_MAP_CLIENT_ID && NAVER_MAP_RUNTIME_ENABLED ? 'checking' : 'failed');
    const [paramName, setParamName] = useState('');

    useEffect(() => {
        let cancelled = false;

        if (!NAVER_MAP_CLIENT_ID || !NAVER_MAP_RUNTIME_ENABLED) {
            setStatus('failed');
            return;
        }

        setStatus('checking');
        preflightNaverMapsScript(NAVER_MAP_CLIENT_ID).then((detectedParamName) => {
            if (cancelled) return;
            setParamName(detectedParamName);
            setStatus(detectedParamName ? 'ready' : 'failed');
        });

        return () => { cancelled = true; };
    }, []);

    if (status === 'ready') {
        return (
            <NaverMapErrorBoundary>
                <NaverMapLayer {...props} paramName={paramName} />
            </NaverMapErrorBoundary>
        );
    }

    return (
        <div className="naver-map-layer">
            <div className="map-loading-panel">
                <strong>{status === 'checking' ? 'Checking NAVER Map' : 'NAVER Map unavailable'}</strong>
                <span>{status === 'checking' ? 'Checking API key and domain settings.' : 'Use Diagram mode when the runtime map is unavailable.'}</span>
            </div>
        </div>
    );
}

function NaverMapLayer({
    stations,
    selectedLine,
    activeLineStationNames,
    routeSegments,
    selectedStation,
    hoveredStation,
    setSelectedStation,
    setHoveredStation,
    getStationStyle,
    getStationMagnitude,
    onClearSelection,
    paramName,
}) {
    const containerRef = useRef(null);
    const mapRef = useRef(null);
    const markersRef = useRef(new Map());
    const routeLinesRef = useRef([]);
    const [isReady, setIsReady] = useState(false);
    const [loadError, setLoadError] = useState('');
    const [hasFitBounds, setHasFitBounds] = useState(false);
    const [mapZoom, setMapZoom] = useState(11);

    useEffect(() => {
        let cancelled = false;

        if (!NAVER_MAP_CLIENT_ID) {
            setLoadError('NAVER_MAP_KEY_MISSING');
            return;
        }

        loadNaverMapsScript(NAVER_MAP_CLIENT_ID, paramName)
            .then(() => {
                if (!cancelled) setIsReady(true);
            })
            .catch(() => {
                if (!cancelled) setLoadError('NAVER_MAP_LOAD_FAILED');
            });

        return () => { cancelled = true; };
    }, [paramName]);

    useEffect(() => {
        if (!isReady || !containerRef.current || mapRef.current) return;

        if (!window.naver?.maps) {
            setLoadError('NAVER_MAP_LOAD_FAILED');
            setIsReady(false);
            return;
        }

        const { naver } = window;
        mapRef.current = new naver.maps.Map(containerRef.current, {
            center: new naver.maps.LatLng(37.5665, 126.9780),
            zoom: 11,
            minZoom: 8,
            maxZoom: 17,
            scaleControl: false,
            logoControl: true,
            mapDataControl: false,
            zoomControl: true,
            zoomControlOptions: {
                position: naver.maps.Position.TOP_RIGHT,
            },
        });

        naver.maps.Event.addListener(mapRef.current, 'click', onClearSelection);
        naver.maps.Event.addListener(mapRef.current, 'zoom_changed', () => {
            setMapZoom(mapRef.current.getZoom());
        });
    }, [isReady, onClearSelection]);

    useEffect(() => {
        if (!isReady) return;

        const timer = window.setTimeout(() => {
            if (!window.naver?.maps || !mapRef.current) {
                setLoadError('NAVER_MAP_LOAD_FAILED');
                setIsReady(false);
            }
        }, 1200);

        return () => window.clearTimeout(timer);
    }, [isReady]);

    useEffect(() => {
        if (!NAVER_MAP_CLIENT_ID || loadError) return;

        const timer = window.setTimeout(() => {
            if (!window.naver?.maps || (stations.length > 0 && markersRef.current.size === 0)) {
                setLoadError('NAVER_MAP_LOAD_FAILED');
                setIsReady(false);
            }
        }, 3500);

        return () => window.clearTimeout(timer);
    }, [loadError, stations.length]);

    useEffect(() => {
        if (!isReady || !mapRef.current || stations.length === 0 || hasFitBounds) return;

        const { naver } = window;
        const firstStation = stations[0];
        const firstPosition = new naver.maps.LatLng(firstStation.y, firstStation.x);
        const bounds = new naver.maps.LatLngBounds(firstPosition, firstPosition);
        stations.slice(1).forEach((station) => bounds.extend(new naver.maps.LatLng(station.y, station.x)));
        mapRef.current.fitBounds(bounds);
        setHasFitBounds(true);
    }, [hasFitBounds, isReady, stations]);

    useEffect(() => {
        if (!isReady || !mapRef.current || !window.naver?.maps) return;

        const { naver } = window;
        routeLinesRef.current.forEach((line) => line.setMap(null));
        routeLinesRef.current = [];

        (routeSegments || []).forEach((lineInfo) => {
            const isVisibleLine = selectedLine === 'All' || lineInfo.id === selectedLine || lineInfo.id.startsWith(selectedLine + '(');
            if (!isVisibleLine) return;

            const selectedOpacity = selectedLine === 'All' ? (mapZoom <= 12 ? 0.26 : 0.12) : 0.78;
            const selectedWeight = selectedLine === 'All' ? (mapZoom <= 12 ? 3 : 2) : 5;

            lineInfo.segments.forEach((segment) => {
                const polyline = new naver.maps.Polyline({
                    map: mapRef.current,
                    path: [
                        new naver.maps.LatLng(segment.start.lat, segment.start.lng),
                        new naver.maps.LatLng(segment.end.lat, segment.end.lng),
                    ],
                    strokeColor: lineInfo.color,
                    strokeOpacity: selectedOpacity,
                    strokeWeight: selectedWeight,
                    strokeLineCap: 'round',
                    strokeLineJoin: 'round',
                    zIndex: selectedLine === 'All' ? 60 : 120,
                });
                routeLinesRef.current.push(polyline);
            });
        });

        return () => {
            routeLinesRef.current.forEach((line) => line.setMap(null));
            routeLinesRef.current = [];
        };
    }, [isReady, mapZoom, routeSegments, selectedLine]);

    useEffect(() => {
        if (!isReady || !mapRef.current) return;

        const { naver } = window;
        const markerMap = markersRef.current;
        const stationIds = new Set(stations.map((station) => station.id));

        markerMap.forEach((entry, id) => {
            if (!stationIds.has(id)) {
                entry.marker.setMap(null);
                entry.listeners.forEach((listener) => naver.maps.Event.removeListener(listener));
                markerMap.delete(id);
            }
        });

        stations.forEach((station) => {
            const style = getStationStyle(station);
            const visible = style.interactive;
            const selected = selectedStation?.id === station.id;
            const hovered = hoveredStation?.id === station.id;
            const magnitude = getStationMagnitude(station);
            const labelled = selectedLine !== 'All' && visible;
            const icon = getNaverMarkerIcon({ station, style, magnitude, selected, hovered, labelled });

            let entry = markerMap.get(station.id);
            if (!entry) {
                const marker = new naver.maps.Marker({
                    position: new naver.maps.LatLng(station.y, station.x),
                    map: visible ? mapRef.current : null,
                    icon,
                    clickable: true,
                    zIndex: selected ? 500 : hovered ? 450 : Math.round(100 + magnitude * 200),
                });

                marker.__station = station;
                const listeners = [
                    naver.maps.Event.addListener(marker, 'click', () => {
                        setSelectedStation(marker.__station);
                    }),
                    naver.maps.Event.addListener(marker, 'mouseover', () => {
                        setHoveredStation(marker.__station);
                    }),
                    naver.maps.Event.addListener(marker, 'mouseout', () => {
                        setHoveredStation(null);
                    }),
                ];

                entry = { marker, listeners };
                markerMap.set(station.id, entry);
            }

            entry.marker.__station = station;
            entry.marker.setPosition(new naver.maps.LatLng(station.y, station.x));
            entry.marker.setIcon(icon);
            entry.marker.setMap(visible ? mapRef.current : null);
            entry.marker.setZIndex(selected ? 500 : hovered ? 450 : Math.round(100 + magnitude * 200));
        });
    }, [
        activeLineStationNames,
        getStationMagnitude,
        getStationStyle,
        hoveredStation,
        isReady,
        selectedLine,
        selectedStation,
        setHoveredStation,
        setSelectedStation,
        stations,
    ]);

    useEffect(() => {
        const markerMap = markersRef.current;
        return () => {
            const { naver } = window;
            markerMap.forEach((entry) => {
                entry.marker.setMap(null);
                if (naver?.maps) entry.listeners.forEach((listener) => naver.maps.Event.removeListener(listener));
            });
            markerMap.clear();
            routeLinesRef.current.forEach((line) => line.setMap(null));
            routeLinesRef.current = [];
        };
    }, []);

    return (
        <div className="naver-map-layer">
            <div ref={containerRef} className="naver-map-canvas" />
            {(!isReady || loadError) && (
                <div className="map-loading-panel">
                    <strong>{loadError ? 'NAVER Map unavailable' : 'Loading NAVER Map'}</strong>
                    <span>{loadError === 'NAVER_MAP_KEY_MISSING' ? 'Check MAP_API in .env.' : loadError ? 'Use Diagram mode while the map service is unavailable.' : 'Preparing map tiles and station markers.'}</span>
                </div>
            )}
        </div>
    );
}

class NaverMapErrorBoundary extends Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false };
    }

    static getDerivedStateFromError() {
        return { hasError: true };
    }

    render() {
        if (this.state.hasError) {
            return (
                <div className="naver-map-layer">
                    <div className="map-loading-panel">
                        <strong>NAVER Map unavailable</strong>
                        <span>Use Diagram mode while the map service is unavailable.</span>
                    </div>
                </div>
            );
        }

        return this.props.children;
    }
}

function RhythmBand({ values = [], currentTime, weatherEvents = [], onHourChange, compact = false }) {
    const maxValue = Math.max(...values, 1);

    return (
        <div className={`rhythm-band ${compact ? 'compact' : ''}`}>
            <div className="rhythm-track">
                {hours.map((hour) => {
                    const value = values[hour] || 0;
                    const event = weatherEvents[hour] || DRY_WEATHER_EVENT;
                    const weatherStyle = getWeatherStyle(event);
                    return (
                        <button
                            key={hour}
                            className={`rhythm-cell ${hour === currentTime ? 'active' : ''} ${event.weatherImpact !== 'Dry' ? 'has-weather' : ''}`}
                            style={{
                                '--load': `${Math.max(0.08, value / maxValue)}`,
                                '--weather-color': weatherStyle.color,
                            }}
                            title={`${hourLabel(hour)} ${formatNumber(value)} ${weatherStyle.label}`}
                            onClick={() => onHourChange?.(hour)}
                        >
                            <span />
                        </button>
                    );
                })}
            </div>
            {!compact && (
                <div className="rhythm-hours">
                    {[0, 6, 12, 18, 23].map((hour) => <span key={hour}>{hourLabel(hour)}</span>)}
                </div>
            )}
        </div>
    );
}

function FlowBalanceBars({ station, currentTime, onHourChange }) {
    const inflow = station?.hourly_inflow || [];
    const outflow = station?.hourly_outflow || [];
    const maxValue = Math.max(...hours.map((hour) => Math.max(inflow[hour] || 0, outflow[hour] || 0)), 1);

    return (
        <div className="flow-balance-container">
            <div className="flow-header">
                <span>Outflow</span>
                <span>Inflow</span>
            </div>
            <div className="flow-balance">
                {hours.map((hour) => (
                    <button
                        key={hour}
                        className={`flow-row ${hour === currentTime ? 'active' : ''}`}
                        onClick={() => onHourChange(hour)}
                        title={`${hourLabel(hour)} Inflow ${formatNumber(inflow[hour])}, Outflow ${formatNumber(outflow[hour])}`}
                    >
                        <span className="flow-hour">{String(hour).padStart(2, '0')}</span>
                        <span className="flow-side out">
                            <i style={{ width: `${((outflow[hour] || 0) / maxValue) * 100}%` }} />
                        </span>
                        <span className="flow-axis" />
                        <span className="flow-side in">
                            <i style={{ width: `${((inflow[hour] || 0) / maxValue) * 100}%` }} />
                        </span>
                    </button>
                ))}
            </div>
            <div className="flow-footer">
                <div className="flow-x-axis">
                    <span>{formatNumber(maxValue)}</span>
                    <span>0</span>
                    <span>{formatNumber(maxValue)}</span>
                </div>
                <div className="x-axis-label">Flow Volume</div>
            </div>
        </div>
    );
}

function WeatherImpactTimeline({ events = [], values = [], currentTime, onHourChange }) {
    const maxValue = Math.max(...values, 1);

    return (
        <div className="weather-timeline-container">
            <div className="y-axis-label">Congestion</div>
            <div className="weather-impact-timeline">
                {hours.map((hour) => {
                    const event = events[hour] || DRY_WEATHER_EVENT;
                    const style = getWeatherStyle(event);
                    const load = values[hour] || 0;
                    return (
                        <button
                            key={hour}
                            className={`weather-tick ${hour === currentTime ? 'active' : ''} ${event.weatherImpact !== 'Dry' ? 'event' : ''}`}
                            style={{
                                '--weather-color': style.color,
                                '--load-height': `${Math.max(8, (load / maxValue) * 72)}%`,
                            }}
                            title={`${hourLabel(hour)} ${style.label}, congestion ${formatNumber(load)}`}
                            onClick={() => onHourChange(hour, event)}
                        >
                            <span className="weather-texture" />
                            <span className="weather-load" />
                        </button>
                    );
                })}
            </div>
            <div className="timeline-x-axis">
                {[0, 6, 12, 18, 23].map((hour) => (
                    <span key={hour}>{String(hour).padStart(2, '0')}</span>
                ))}
            </div>
            <div className="x-axis-label">Time (Hour)</div>
        </div>
    );
}

function SimilarStationOrbit({ station, onCompare }) {
    const similar = (station?.similar_stations || []).slice(0, 8);
    const maxScore = Math.max(...similar.map((item) => item.score || 0), 1);

    return (
        <div className="similar-orbit">
            <div className="orbit-center">
                <strong>{station?.name}</strong>
                <span>{getStationTypeLabel(station?.station_type)}</span>
            </div>
            {similar.map((item, index) => {
                const angle = (-90 + (360 / Math.max(similar.length, 1)) * index) * (Math.PI / 180);
                const normalized = (item.score || 0) / maxScore;
                const radius = 118 - normalized * 28;
                const x = Math.cos(angle) * radius;
                const y = Math.sin(angle) * radius;
                return (
                    <button
                        key={`${item.name}-${index}`}
                        className="orbit-node"
                        style={{
                            transform: `translate(${x}px, ${y}px)`,
                            '--score': `${normalized}`,
                        }}
                        onClick={() => onCompare(item.name)}
                        title={`${item.name} similarity ${item.score}%`}
                    >
                        <strong>{item.name}</strong>
                        <span>{item.score}%</span>
                    </button>
                );
            })}
        </div>
    );
}

function OverviewPanel({ overview, currentTime, weatherEvents, onHourChange }) {
    if (!overview) {
        return <div className="empty-selection"><p>Loading overview</p></div>;
    }

    return (
        <div className="dashboard-content overview-panel">
            <div className="overview-header">
                <span>Today Overview</span>
                <strong>{overview.date}</strong>
            </div>
            <div className="overview-metrics">
                <div>
                    <span>Day Type</span>
                    <strong>{overview.dayType}</strong>
                </div>
                <div>
                    <span>Peak Hour</span>
                    <strong>{hourLabel(overview.peakHour)}</strong>
                </div>
            </div>
            <section className="overview-section">
                <h4>24h Network Rhythm</h4>
                <RhythmBand values={overview.hourlyNetworkLoad} currentTime={currentTime} weatherEvents={weatherEvents} onHourChange={onHourChange} />
            </section>
            <section className="overview-section">
                <h4>Top 5 Busiest Stations</h4>
                <div className="top-stations">
                    {overview.topStations.map((station) => (
                        <div key={station.name} className="top-station-row">
                            <span>{station.name}</span>
                            <strong>{formatNumber(station.value)}</strong>
                        </div>
                    ))}
                </div>
            </section>
            <section className="overview-section compact-summary">
                <div>
                    <span>Rain/Snow Summary</span>
                    <strong>{overview.weatherSummary}</strong>
                </div>
                <div>
                    <span>Quieter Hours</span>
                    <strong>{overview.quietHours.map(hourLabel).join(' / ')}</strong>
                </div>
            </section>
        </div>
    );
}

function LiveNowCard({ station, areaMap, status, data }) {
    const areaLabel = areaMap?.label || areaMap?.area || '';
    const unavailableCopy = {
        unmapped: 'No Seoul live area mapping for this station.',
        'missing-key': 'CITY_DATA_API_KEY is not configured.',
        unavailable: 'The live city feed could not be reached.',
    };

    return (
        <div className={`live-card ${status === 'ready' ? 'ready' : ''}`}>
            <div className="live-card-title">
                <span>Live Now</span>
                <strong>{areaLabel || cleanStationName(station?.name)}</strong>
            </div>
            {status === 'loading' ? (
                <p>Loading live context...</p>
            ) : status !== 'ready' ? (
                <p><strong>Live data unavailable</strong><br />{unavailableCopy[status] || unavailableCopy.unavailable}</p>
            ) : (
                <div className="live-grid">
                    <div><span>Area Congestion</span><strong>{data.congestion || 'Unknown'}</strong></div>
                    <div><span>Live Population</span><strong>{data.population || 'Unknown'}</strong></div>
                    <div><span>Subway Status</span><strong>{data.subway || 'No report'}</strong></div>
                    <div><span>Weather</span><strong>{data.weather || 'No report'}</strong></div>
                    <div className="live-wide"><span>Message</span><strong>{data.message || 'No message'}</strong></div>
                    <div className="live-wide"><span>Event</span><strong>{data.event || 'No event reported'}</strong></div>
                </div>
            )}
        </div>
    );
}

function ComparePanel({ station, compareStation, compareName, onCompareChange }) {
    const similar = station?.similar_stations || [];
    const stationPeak = station?.hourly_congestion?.indexOf(Math.max(...(station?.hourly_congestion || [0]))) ?? 0;
    const comparePeak = compareStation?.hourly_congestion?.indexOf(Math.max(...(compareStation?.hourly_congestion || [0]))) ?? 0;

    return (
        <div className="compare-panel">
            <div className="compare-heading">
                <h4>Compare Mode</h4>
                <select value={compareName} onChange={(event) => onCompareChange(event.target.value)}>
                    <option value="">Choose similar station</option>
                    {similar.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
                </select>
            </div>
            {compareStation ? (
                <div className="compare-grid">
                    {[station, compareStation].map((item) => {
                        const total = (item.hourly_congestion || []).reduce((sum, value) => sum + value, 0);
                        const peak = item.id === station.id ? stationPeak : comparePeak;
                        return (
                            <div key={item.id} className="compare-card">
                                <strong>{item.name}</strong>
                                <span>{getStationTypeLabel(item.station_type)}</span>
                                <div className="compare-stat"><em>Daily Load</em><b>{formatNumber(total)}</b></div>
                                <div className="compare-stat"><em>Peak</em><b>{hourLabel(peak)}</b></div>
                            </div>
                        );
                    })}
                </div>
            ) : (
                <p className="compare-empty">Pick one orbit station to compare historical patterns side by side.</p>
            )}
        </div>
    );
}

function normalizeLiveCityData(payload) {
    const data = payload?.CITYDATA || payload?.citydata || payload;
    const first = (value) => Array.isArray(value) ? value[0] : value;
    const asList = (value) => Array.isArray(value) ? value : value ? [value] : [];
    const population = first(data?.LIVE_PPLTN_STTS) || {};
    const subPopulation = first(data?.LIVE_SUB_PPLTN) || {};
    const subway = first(data?.SUB_STTS) || {};
    const weather = first(data?.WEATHER_STTS) || {};
    const events = asList(data?.EVENT_STTS);
    const minPop = population.AREA_PPLTN_MIN || population.AREA_PPLTN_MIN || subPopulation.SUB_PPLTN_MIN;
    const maxPop = population.AREA_PPLTN_MAX || population.AREA_PPLTN_MAX || subPopulation.SUB_PPLTN_MAX;

    return {
        congestion: population.AREA_CONGEST_LVL || population.AREA_CONGEST || '',
        message: population.AREA_CONGEST_MSG || population.AREA_PPLTN_MSG || '',
        population: minPop && maxPop ? `${formatNumber(minPop)}-${formatNumber(maxPop)}` : '',
        subway: subway.SUB_STTS || subway.SUB_MSG || subPopulation.SUB_PPLTN || subPopulation.SUB_CONGEST_LVL || '',
        weather: weather.WEATHER_STTS || weather.TEMP ? `${weather.WEATHER_STTS || 'Weather'} ${weather.TEMP ? `${weather.TEMP}C` : ''}`.trim() : '',
        event: events.length > 0 ? (events[0].EVENT_NM || events[0].EVENT_NAME || 'Event reported') : 'No event reported',
    };
}

/**
 * Seoul Subway Population Movement Flow - Professional Analytics
 */
function App() {
    const [selectedDate, setSelectedDate] = useState('');
    const [currentDay, setCurrentDay] = useState(null);
    const [stations, setStations] = useState([]);
    const [globalDailyMaxCongestion, setGlobalDailyMaxCongestion] = useState(1);
    const [globalDailyMaxStay, setGlobalDailyMaxStay] = useState(1);
    const [viewBox, setViewBox] = useState({ x: 0, y: 0, w: 100, h: 100 });
    const isDragging = useRef(false);
    const lastMousePos = useRef({ x: 0, y: 0 });
    const [currentTime, setCurrentTime] = useState(8);
    const [viewMode, setViewMode] = useState('congestion'); 
    const [selectedLine, setSelectedLine] = useState('All'); 
    const [hoveredStation, setHoveredStation] = useState(null);
    const [selectedStation, setSelectedStation] = useState(null);
    const [lastWeekStation, setLastWeekStation] = useState(null); 
    const [scatterTooltip, setScatterTooltip] = useState(null); 
    const [congestTooltip, setCongestTooltip] = useState(null); 
    const [geoJson, setGeoJson] = useState(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [isCustomOpen, setIsCustomOpen] = useState(false);
    const [customFilters, setCustomFilters] = useState({
        date: '',
        time: '',
        temp: '',
        line: 'All'
    });
    const [customResults, setCustomResults] = useState([]);
    const [legendHighlight, setLegendHighlight] = useState(null);
    const [mapSurface, setMapSurface] = useState('diagram');
    const [stationProfiles, setStationProfiles] = useState({});
    const [stationProfilesByCleanName, setStationProfilesByCleanName] = useState({});
    const [weatherEvents, setWeatherEvents] = useState({});
    const [cityDataAreaMap, setCityDataAreaMap] = useState({});
    const [liveStatus, setLiveStatus] = useState('unmapped');
    const [liveCityData, setLiveCityData] = useState(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [compareStationName, setCompareStationName] = useState('');
    const [weatherFocusHour, setWeatherFocusHour] = useState(null);

    const lineColors = {
        "1호선": "#0052A4", "2호선": "#00A84D", "3호선": "#EF7C1C",
        "4호선": "#00A4E3", "5호선": "#996CAC", "6호선": "#CD7C2F",
        "7호선": "#747F00", "8호선": "#E6186C", "9호선": "#BDB092"
    };
    const StateColors = {
        "Crowded": "#f04438", "Moderate": "#9b1c1c", "Normal": "#16a34a", "Smooth": "#a3e635"
    };
    const SUBWAY_LINES = [
      {
        line: "1호선",
        color: "#0052A4",
        stations: [
          { name: "연천", isTransfer: false, transferTo: [] }, { name: "전곡", isTransfer: false, transferTo: [] }, { name: "청산", isTransfer: false, transferTo: [] }, { name: "소요산", isTransfer: false, transferTo: [] }, { name: "동두천", isTransfer: false, transferTo: [] }, { name: "보산", isTransfer: false, transferTo: [] }, { name: "동두천중앙", isTransfer: false, transferTo: [] }, { name: "지행", isTransfer: false, transferTo: [] }, { name: "덕정", isTransfer: false, transferTo: [] }, { name: "덕계", isTransfer: false, transferTo: [] }, { name: "양주", isTransfer: false, transferTo: [] }, { name: "녹양", isTransfer: false, transferTo: [] }, { name: "가능", isTransfer: false, transferTo: [] }, { name: "의정부", isTransfer: false, transferTo: [] }, { name: "회룡", isTransfer: false, transferTo: [] }, { name: "망월사", isTransfer: false, transferTo: [] }, { name: "도봉산", isTransfer: true, transferTo: ["7호선"] }, { name: "도봉", isTransfer: false, transferTo: [] }, { name: "방학", isTransfer: false, transferTo: [] }, { name: "창동", isTransfer: true, transferTo: ["4호선"] }, { name: "녹천", isTransfer: false, transferTo: [] }, { name: "월계", isTransfer: false, transferTo: [] }, { name: "광운대", isTransfer: false, transferTo: [] }, { name: "석계", isTransfer: true, transferTo: ["6호선"] }, { name: "신이문", isTransfer: false, transferTo: [] }, { name: "외대앞", isTransfer: false, transferTo: [] }, { name: "회기", isTransfer: false, transferTo: [] }, { name: "청량리", isTransfer: false, transferTo: [] }, { name: "제기동", isTransfer: false, transferTo: [] }, { name: "신설동", isTransfer: true, transferTo: ["2호선(성수지선)"] }, { name: "동묘앞", isTransfer: true, transferTo: ["6호선"] }, { name: "동대문", isTransfer: true, transferTo: ["4호선"] }, { name: "종로5가", isTransfer: false, transferTo: [] }, { name: "종로3가", isTransfer: true, transferTo: ["3호선", "5호선"] }, { name: "종각", isTransfer: false, transferTo: [] }, { name: "시청", isTransfer: true, transferTo: ["2호선"] }, { name: "서울역", isTransfer: true, transferTo: ["4호선"] }, { name: "남영", isTransfer: false, transferTo: [] }, { name: "용산", isTransfer: false, transferTo: [] }, { name: "노량진", isTransfer: true, transferTo: ["9호선"] }, { name: "대방", isTransfer: false, transferTo: [] }, { name: "신길", isTransfer: true, transferTo: ["5호선"] }, { name: "영등포", isTransfer: false, transferTo: [] }, { name: "신도림", isTransfer: true, transferTo: ["2호선", "2호선(신정지선)"] }, { name: "구로", isTransfer: true, transferTo: ["1호선(경부선)"] }, { name: "구일", isTransfer: false, transferTo: [] }, { name: "개봉", isTransfer: false, transferTo: [] }, { name: "오류동", isTransfer: false, transferTo: [] }, { name: "온수", isTransfer: true, transferTo: ["7호선"] }, { name: "역곡", isTransfer: false, transferTo: [] }, { name: "소사", isTransfer: false, transferTo: [] }, { name: "부천", isTransfer: false, transferTo: [] }, { name: "중동", isTransfer: false, transferTo: [] }, { name: "송내", isTransfer: false, transferTo: [] }, { name: "부개", isTransfer: false, transferTo: [] }, { name: "부평", isTransfer: false, transferTo: [] }, { name: "백운", isTransfer: false, transferTo: [] }, { name: "동암", isTransfer: false, transferTo: [] }, { name: "간석", isTransfer: false, transferTo: [] }, { name: "주안", isTransfer: false, transferTo: [] }, { name: "도화", isTransfer: false, transferTo: [] }, { name: "제물포", isTransfer: false, transferTo: [] }, { name: "도원", isTransfer: false, transferTo: [] }, { name: "동인천", isTransfer: false, transferTo: [] }, { name: "인천", isTransfer: false, transferTo: [] }
        ]
      },
      {
        line: "1호선(경부선)",
        color: "#0052A4",
        stations: [
          { name: "구로", isTransfer: true, transferTo: ["1호선"] }, { name: "가산디지털단지", isTransfer: true, transferTo: ["7호선"] }, { name: "독산", isTransfer: false, transferTo: [] }, { name: "금천구청", isTransfer: false, transferTo: [] }, { name: "석수", isTransfer: false, transferTo: [] }, { name: "관악", isTransfer: false, transferTo: [] }, { name: "안양", isTransfer: false, transferTo: [] }, { name: "명학", isTransfer: false, transferTo: [] }, { name: "금정", isTransfer: true, transferTo: ["4호선"] }, { name: "군포", isTransfer: false, transferTo: [] }, { name: "당정", isTransfer: false, transferTo: [] }, { name: "의왕", isTransfer: false, transferTo: [] }, { name: "성균관대", isTransfer: false, transferTo: [] }, { name: "화서", isTransfer: false, transferTo: [] }, { name: "수원", isTransfer: false, transferTo: [] }, { name: "세류", isTransfer: false, transferTo: [] }, { name: "병점", isTransfer: false, transferTo: [] }, { name: "세마", isTransfer: false, transferTo: [] }, { name: "오산대", isTransfer: false, transferTo: [] }, { name: "오산", isTransfer: false, transferTo: [] }, { name: "진위", isTransfer: false, transferTo: [] }, { name: "송탄", isTransfer: false, transferTo: [] }, { name: "서정리", isTransfer: false, transferTo: [] }, { name: "평택지제", isTransfer: false, transferTo: [] }, { name: "평택", isTransfer: false, transferTo: [] }, { name: "성환", isTransfer: false, transferTo: [] }, { name: "직산", isTransfer: false, transferTo: [] }, { name: "두정", isTransfer: false, transferTo: [] }, { name: "천안", isTransfer: false, transferTo: [] }, { name: "봉명", isTransfer: false, transferTo: [] }, { name: "쌍용", isTransfer: false, transferTo: [] }, { name: "아산", isTransfer: false, transferTo: [] }, { name: "배방", isTransfer: false, transferTo: [] }, { name: "온양온천", isTransfer: false, transferTo: [] }, { name: "신창", isTransfer: false, transferTo: [] }
        ]
      },
      {
        line: "2호선",
        color: "#00A84D",
        stations: [
          { name: "시청", isTransfer: true, transferTo: ["1호선"] }, { name: "을지로입구", isTransfer: false, transferTo: [] }, { name: "을지로3가", isTransfer: true, transferTo: ["3호선"] }, { name: "을지로4가", isTransfer: true, transferTo: ["5호선"] }, { name: "동대문역사문화공원", isTransfer: true, transferTo: ["4호선", "5호선"] }, { name: "신당", isTransfer: true, transferTo: ["6호선"] }, { name: "상왕십리", isTransfer: false, transferTo: [] }, { name: "왕십리", isTransfer: true, transferTo: ["5호선"] }, { name: "한양대", isTransfer: false, transferTo: [] }, { name: "뚝섬", isTransfer: false, transferTo: [] }, { name: "성수", isTransfer: true, transferTo: ["2호선(성수지선)"] }, { name: "건대입구", isTransfer: true, transferTo: ["7호선"] }, { name: "구의", isTransfer: false, transferTo: [] }, { name: "강변", isTransfer: false, transferTo: [] }, { name: "잠실나루", isTransfer: false, transferTo: [] }, { name: "잠실", isTransfer: true, transferTo: ["8호선"] }, { name: "잠실새내", isTransfer: false, transferTo: [] }, { name: "종합운동장", isTransfer: true, transferTo: ["9호선"] }, { name: "삼성", isTransfer: false, transferTo: [] }, { name: "선릉", isTransfer: false, transferTo: [] }, { name: "역삼", isTransfer: false, transferTo: [] }, { name: "강남", isTransfer: false, transferTo: [] }, { name: "교대", isTransfer: true, transferTo: ["3호선"] }, { name: "서초", isTransfer: false, transferTo: [] }, { name: "방배", isTransfer: false, transferTo: [] }, { name: "사당", isTransfer: true, transferTo: ["4호선"] }, { name: "낙성대", isTransfer: false, transferTo: [] }, { name: "서울대입구", isTransfer: false, transferTo: [] }, { name: "봉천", isTransfer: false, transferTo: [] }, { name: "신림", isTransfer: false, transferTo: [] }, { name: "신대방", isTransfer: false, transferTo: [] }, { name: "구로디지털단지", isTransfer: false, transferTo: [] }, { name: "대림", isTransfer: true, transferTo: ["7호선"] }, { name: "신도림", isTransfer: true, transferTo: ["1호선", "2호선(신정지선)"] }, { name: "문래", isTransfer: false, transferTo: [] }, { name: "영등포구청", isTransfer: true, transferTo: ["5호선"] }, { name: "당산", isTransfer: true, transferTo: ["9호선"] }, { name: "합정", isTransfer: true, transferTo: ["6호선"] }, { name: "홍대입구", isTransfer: false, transferTo: [] }, { name: "신촌", isTransfer: false, transferTo: [] }, { name: "이대", isTransfer: false, transferTo: [] }, { name: "아현", isTransfer: false, transferTo: [] }, { name: "충정로", isTransfer: true, transferTo: ["5호선"] }, { name: "시청", isTransfer: true, transferTo: ["1호선"] }
        ]
      },
      {
        line: "2호선(성수지선)",
        color: "#00A84D",
        stations: [
          { name: "성수", isTransfer: true, transferTo: ["2호선"] }, { name: "용답", isTransfer: false, transferTo: [] }, { name: "신답", isTransfer: false, transferTo: [] }, { name: "용두", isTransfer: false, transferTo: [] }, { name: "신설동", isTransfer: true, transferTo: ["1호선"] }
        ]
      },
      {
        line: "2호선(신정지선)",
        color: "#00A84D",
        stations: [
          { name: "신도림", isTransfer: true, transferTo: ["1호선", "2호선"] }, { name: "도림천", isTransfer: false, transferTo: [] }, { name: "양천구청", isTransfer: false, transferTo: [] }, { name: "신정네거리", isTransfer: false, transferTo: [] }, { name: "까치산", isTransfer: true, transferTo: ["5호선"] }
        ]
      },
      {
        line: "3호선",
        color: "#EF7C1C",
        stations: [
          { name: "대화", isTransfer: false, transferTo: [] }, { name: "주엽", isTransfer: false, transferTo: [] }, { name: "정발산", isTransfer: false, transferTo: [] }, { name: "마두", isTransfer: false, transferTo: [] }, { name: "백석", isTransfer: false, transferTo: [] }, { name: "대곡", isTransfer: false, transferTo: [] }, { name: "화정", isTransfer: false, transferTo: [] }, { name: "원당", isTransfer: false, transferTo: [] }, { name: "원흥", isTransfer: false, transferTo: [] }, { name: "삼송", isTransfer: false, transferTo: [] }, { name: "지축", isTransfer: false, transferTo: [] }, { name: "구파발", isTransfer: false, transferTo: [] }, { name: "연신내", isTransfer: true, transferTo: ["6호선"] }, { name: "불광", isTransfer: true, transferTo: ["6호선"] }, { name: "녹번", isTransfer: false, transferTo: [] }, { name: "홍제", isTransfer: false, transferTo: [] }, { name: "무악재", isTransfer: false, transferTo: [] }, { name: "독립문", isTransfer: false, transferTo: [] }, { name: "경복궁", isTransfer: false, transferTo: [] }, { name: "안국", isTransfer: false, transferTo: [] }, { name: "종로3가", isTransfer: true, transferTo: ["1호선", "5호선"] }, { name: "을지로3가", isTransfer: true, transferTo: ["2호선"] }, { name: "충무로", isTransfer: true, transferTo: ["4호선"] }, { name: "동대입구", isTransfer: false, transferTo: [] }, { name: "약수", isTransfer: true, transferTo: ["6호선"] }, { name: "금호", isTransfer: false, transferTo: [] }, { name: "옥수", isTransfer: false, transferTo: [] }, { name: "압구정", isTransfer: false, transferTo: [] }, { name: "신사", isTransfer: false, transferTo: [] }, { name: "잠원", isTransfer: false, transferTo: [] }, { name: "고속터미널", isTransfer: true, transferTo: ["7호선", "9호선"] }, { name: "교대", isTransfer: true, transferTo: ["2호선"] }, { name: "남부터미널", isTransfer: false, transferTo: [] }, { name: "양재", isTransfer: false, transferTo: [] }, { name: "매봉", isTransfer: false, transferTo: [] }, { name: "도곡", isTransfer: false, transferTo: [] }, { name: "대치", isTransfer: false, transferTo: [] }, { name: "학여울", isTransfer: false, transferTo: [] }, { name: "대청", isTransfer: false, transferTo: [] }, { name: "일원", isTransfer: false, transferTo: [] }, { name: "수서", isTransfer: false, transferTo: [] }, { name: "가락시장", isTransfer: true, transferTo: ["8호선"] }, { name: "경찰병원", isTransfer: false, transferTo: [] }, { name: "오금", isTransfer: true, transferTo: ["5호선(마천지선)"] }
        ]
      },
      {
        line: "4호선",
        color: "#00A4E3",
        stations: [
          { name: "진접", isTransfer: false, transferTo: [] }, { name: "오남", isTransfer: false, transferTo: [] }, { name: "별내별가람", isTransfer: false, transferTo: [] }, { name: "당고개", isTransfer: false, transferTo: [] }, { name: "상계", isTransfer: false, transferTo: [] }, { name: "노원", isTransfer: true, transferTo: ["7호선"] }, { name: "창동", isTransfer: true, transferTo: ["1호선"] }, { name: "쌍문", isTransfer: false, transferTo: [] }, { name: "수유", isTransfer: false, transferTo: [] }, { name: "미아", isTransfer: false, transferTo: [] }, { name: "미아사거리", isTransfer: false, transferTo: [] }, { name: "길음", isTransfer: false, transferTo: [] }, { name: "성신여대입구", isTransfer: false, transferTo: [] }, { name: "한성대입구", isTransfer: false, transferTo: [] }, { name: "혜화", isTransfer: false, transferTo: [] }, { name: "동대문", isTransfer: true, transferTo: ["1호선"] }, { name: "동대문역사문화공원", isTransfer: true, transferTo: ["2호선", "5호선"] }, { name: "충무로", isTransfer: true, transferTo: ["3호선"] }, { name: "명동", isTransfer: false, transferTo: [] }, { name: "회현", isTransfer: false, transferTo: [] }, { name: "서울역", isTransfer: true, transferTo: ["1호선"] }, { name: "숙대입구", isTransfer: false, transferTo: [] }, { name: "삼각지", isTransfer: true, transferTo: ["6호선"] }, { name: "신용산", isTransfer: false, transferTo: [] }, { name: "이촌", isTransfer: false, transferTo: [] }, { name: "동작", isTransfer: true, transferTo: ["9호선"] }, { name: "이수", isTransfer: true, transferTo: ["7호선"] }, { name: "사당", isTransfer: true, transferTo: ["2호선"] }, { name: "남태령", isTransfer: false, transferTo: [] }, { name: "선바위", isTransfer: false, transferTo: [] }, { name: "경마공원", isTransfer: false, transferTo: [] }, { name: "대공원", isTransfer: false, transferTo: [] }, { name: "과천", isTransfer: false, transferTo: [] }, { name: "정부과천청사", isTransfer: false, transferTo: [] }, { name: "인덕원", isTransfer: false, transferTo: [] }, { name: "평촌", isTransfer: false, transferTo: [] }, { name: "범계", isTransfer: false, transferTo: [] }, { name: "금정", isTransfer: true, transferTo: ["1호선(경부선)"] }, { name: "산본", isTransfer: false, transferTo: [] }, { name: "수리산", isTransfer: false, transferTo: [] }, { name: "대야미", isTransfer: false, transferTo: [] }, { name: "반월", isTransfer: false, transferTo: [] }, { name: "상록수", isTransfer: false, transferTo: [] }, { name: "한대앞", isTransfer: false, transferTo: [] }, { name: "중앙", isTransfer: false, transferTo: [] }, { name: "고잔", isTransfer: false, transferTo: [] }, { name: "초지", isTransfer: false, transferTo: [] }, { name: "안산", isTransfer: false, transferTo: [] }, { name: "신길온천", isTransfer: false, transferTo: [] }, { name: "정왕", isTransfer: false, transferTo: [] }, { name: "오이도", isTransfer: false, transferTo: [] }
        ]
      },
      {
        line: "5호선",
        color: "#996CAC",
        stations: [
          { name: "방화", isTransfer: false, transferTo: [] }, { name: "개화산", isTransfer: false, transferTo: [] }, { name: "김포공항", isTransfer: true, transferTo: ["9호선"] }, { name: "송정", isTransfer: false, transferTo: [] }, { name: "마곡", isTransfer: false, transferTo: [] }, { name: "발산", isTransfer: false, transferTo: [] }, { name: "우장산", isTransfer: false, transferTo: [] }, { name: "화곡", isTransfer: false, transferTo: [] }, { name: "까치산", isTransfer: true, transferTo: ["2호선(신정지선)"] }, { name: "신정", isTransfer: false, transferTo: [] }, { name: "목동", isTransfer: false, transferTo: [] }, { name: "오목교", isTransfer: false, transferTo: [] }, { name: "양평", isTransfer: false, transferTo: [] }, { name: "영등포구청", isTransfer: true, transferTo: ["2호선"] }, { name: "영등포시장", isTransfer: false, transferTo: [] }, { name: "신길", isTransfer: true, transferTo: ["1호선"] }, { name: "여의도", isTransfer: true, transferTo: ["9호선"] }, { name: "여의나루", isTransfer: false, transferTo: [] }, { name: "마포", isTransfer: false, transferTo: [] }, { name: "공덕", isTransfer: true, transferTo: ["6호선"] }, { name: "애오개", isTransfer: false, transferTo: [] }, { name: "충정로", isTransfer: true, transferTo: ["2호선"] }, { name: "서대문", isTransfer: false, transferTo: [] }, { name: "광화문", isTransfer: false, transferTo: [] }, { name: "종로3가", isTransfer: true, transferTo: ["1호선", "3호선"] }, { name: "을지로4가", isTransfer: true, transferTo: ["2호선"] }, { name: "동대문역사문화공원", isTransfer: true, transferTo: ["2호선", "4호선"] }, { name: "청구", isTransfer: true, transferTo: ["6호선"] }, { name: "신금호", isTransfer: false, transferTo: [] }, { name: "행당", isTransfer: false, transferTo: [] }, { name: "왕십리", isTransfer: true, transferTo: ["2호선"] }, { name: "마장", isTransfer: false, transferTo: [] }, { name: "답십리", isTransfer: false, transferTo: [] }, { name: "장한평", isTransfer: false, transferTo: [] }, { name: "군자", isTransfer: true, transferTo: ["7호선"] }, { name: "아차산", isTransfer: false, transferTo: [] }, { name: "광나루", isTransfer: false, transferTo: [] }, { name: "천호", isTransfer: true, transferTo: ["8호선"] }, { name: "강동", isTransfer: true, transferTo: ["5호선(마천지선)"] }, { name: "길동", isTransfer: false, transferTo: [] }, { name: "굽은다리", isTransfer: false, transferTo: [] }, { name: "명일", isTransfer: false, transferTo: [] }, { name: "고덕", isTransfer: false, transferTo: [] }, { name: "상일동", isTransfer: false, transferTo: [] }, { name: "강일", isTransfer: false, transferTo: [] }, { name: "미사", isTransfer: false, transferTo: [] }, { name: "하남풍산", isTransfer: false, transferTo: [] }, { name: "하남시청", isTransfer: false, transferTo: [] }, { name: "하남검단산", isTransfer: false, transferTo: [] }
        ]
      },
      {
        line: "5호선(마천지선)",
        color: "#996CAC",
        stations: [
          { name: "강동", isTransfer: true, transferTo: ["5호선"] }, { name: "둔촌동", isTransfer: false, transferTo: [] }, { name: "올림픽공원", isTransfer: true, transferTo: ["9호선"] }, { name: "방이", isTransfer: false, transferTo: [] }, { name: "오금", isTransfer: true, transferTo: ["3호선"] }, { name: "개롱", isTransfer: false, transferTo: [] }, { name: "거여", isTransfer: false, transferTo: [] }, { name: "마천", isTransfer: false, transferTo: [] }
        ]
      },
      {
        line: "6호선",
        color: "#CD7C2F",
        stations: [
          { name: "응암", isTransfer: false, transferTo: [] }, { name: "역촌", isTransfer: false, transferTo: [] }, { name: "불광", isTransfer: true, transferTo: ["3호선"] }, { name: "독바위", isTransfer: false, transferTo: [] }, { name: "연신내", isTransfer: true, transferTo: ["3호선"] }, { name: "구산", isTransfer: false, transferTo: [] }, { name: "새절", isTransfer: false, transferTo: [] }, { name: "증산", isTransfer: false, transferTo: [] }, { name: "디지털미디어시티", isTransfer: false, transferTo: [] }, { name: "월드컵경기장", isTransfer: false, transferTo: [] }, { name: "마포구청", isTransfer: false, transferTo: [] }, { name: "망원", isTransfer: false, transferTo: [] }, { name: "합정", isTransfer: true, transferTo: ["2호선"] }, { name: "상수", isTransfer: false, transferTo: [] }, { name: "광흥창", isTransfer: false, transferTo: [] }, { name: "대흥", isTransfer: false, transferTo: [] }, { name: "공덕", isTransfer: true, transferTo: ["5호선"] }, { name: "효창공원앞", isTransfer: false, transferTo: [] }, { name: "삼각지", isTransfer: true, transferTo: ["4호선"] }, { name: "녹사평", isTransfer: false, transferTo: [] }, { name: "이태원", isTransfer: false, transferTo: [] }, { name: "한강진", isTransfer: false, transferTo: [] }, { name: "버티고개", isTransfer: false, transferTo: [] }, { name: "약수", isTransfer: true, transferTo: ["3호선"] }, { name: "청구", isTransfer: true, transferTo: ["5호선"] }, { name: "신당", isTransfer: true, transferTo: ["2호선"] }, { name: "동묘앞", isTransfer: true, transferTo: ["1호선"] }, { name: "창신", isTransfer: false, transferTo: [] }, { name: "보문", isTransfer: false, transferTo: [] }, { name: "안암", isTransfer: false, transferTo: [] }, { name: "고려대", isTransfer: false, transferTo: [] }, { name: "월곡", isTransfer: false, transferTo: [] }, { name: "상월곡", isTransfer: false, transferTo: [] }, { name: "돌곶이", isTransfer: false, transferTo: [] }, { name: "석계", isTransfer: true, transferTo: ["1호선"] }, { name: "태릉입구", isTransfer: true, transferTo: ["7호선"] }, { name: "화랑대", isTransfer: false, transferTo: [] }, { name: "봉화산", isTransfer: false, transferTo: [] }, { name: "신내", isTransfer: false, transferTo: [] }
        ]
      },
      {
        line: "7호선",
        color: "#747F00",
        stations: [
          { name: "장암", isTransfer: false, transferTo: [] }, { name: "도봉산", isTransfer: true, transferTo: ["1호선"] }, { name: "수락산", isTransfer: false, transferTo: [] }, { name: "마들", isTransfer: false, transferTo: [] }, { name: "노원", isTransfer: true, transferTo: ["4호선"] }, { name: "중계", isTransfer: false, transferTo: [] }, { name: "하계", isTransfer: false, transferTo: [] }, { name: "공릉", isTransfer: false, transferTo: [] }, { name: "태릉입구", isTransfer: true, transferTo: ["6호선"] }, { name: "먹골", isTransfer: false, transferTo: [] }, { name: "중화", isTransfer: false, transferTo: [] }, { name: "상봉", isTransfer: false, transferTo: [] }, { name: "면목", isTransfer: false, transferTo: [] }, { name: "사가정", isTransfer: false, transferTo: [] }, { name: "용마산", isTransfer: false, transferTo: [] }, { name: "중곡", isTransfer: false, transferTo: [] }, { name: "군자", isTransfer: true, transferTo: ["5호선"] }, { name: "어린이대공원", isTransfer: false, transferTo: [] }, { name: "건대입구", isTransfer: true, transferTo: ["2호선"] }, { name: "뚝섬유원지", isTransfer: false, transferTo: [] }, { name: "청담", isTransfer: false, transferTo: [] }, { name: "강남구청", isTransfer: false, transferTo: [] }, { name: "학동", isTransfer: false, transferTo: [] }, { name: "논현", isTransfer: false, transferTo: [] }, { name: "반포", isTransfer: false, transferTo: [] }, { name: "고속터미널", isTransfer: true, transferTo: ["3호선", "9호선"] }, { name: "내방", isTransfer: false, transferTo: [] }, { name: "이수", isTransfer: true, transferTo: ["4호선"] }, { name: "남성", isTransfer: false, transferTo: [] }, { name: "숭실대입구", isTransfer: false, transferTo: [] }, { name: "상도", isTransfer: false, transferTo: [] }, { name: "장승배기", isTransfer: false, transferTo: [] }, { name: "신대방삼거리", isTransfer: false, transferTo: [] }, { name: "보라매", isTransfer: false, transferTo: [] }, { name: "신풍", isTransfer: false, transferTo: [] }, { name: "대림", isTransfer: true, transferTo: ["2호선"] }, { name: "남구로", isTransfer: false, transferTo: [] }, { name: "가산디지털단지", isTransfer: true, transferTo: ["1호선(경부선)"] }, { name: "철산", isTransfer: false, transferTo: [] }, { name: "광명사거리", isTransfer: false, transferTo: [] }, { name: "천왕", isTransfer: false, transferTo: [] }, { name: "온수", isTransfer: true, transferTo: ["1호선"] }, { name: "까치울", isTransfer: false, transferTo: [] }, { name: "부천종합운동장", isTransfer: false, transferTo: [] }, { name: "춘의", isTransfer: false, transferTo: [] }, { name: "신중동", isTransfer: false, transferTo: [] }, { name: "부천시청", isTransfer: false, transferTo: [] }, { name: "상동", isTransfer: false, transferTo: [] }, { name: "삼산체육관", isTransfer: false, transferTo: [] }, { name: "굴포천", isTransfer: false, transferTo: [] }, { name: "부평구청", isTransfer: false, transferTo: [] }, { name: "산곡", isTransfer: false, transferTo: [] }, { name: "석남", isTransfer: false, transferTo: [] }
        ]
      },
      {
        line: "8호선",
        color: "#E6186C",
        stations: [
          { name: "별내", isTransfer: false, transferTo: [] }, { name: "다산", isTransfer: false, transferTo: [] }, { name: "동구릉", isTransfer: false, transferTo: [] }, { name: "구리", isTransfer: false, transferTo: [] }, { name: "장자호수공원", isTransfer: false, transferTo: [] }, { name: "암사역사공원", isTransfer: false, transferTo: [] }, { name: "암사", isTransfer: false, transferTo: [] }, { name: "천호", isTransfer: true, transferTo: ["5호선"] }, { name: "강동구청", isTransfer: false, transferTo: [] }, { name: "몽촌토성", isTransfer: false, transferTo: [] }, { name: "잠실", isTransfer: true, transferTo: ["2호선"] }, { name: "석촌", isTransfer: true, transferTo: ["9호선"] }, { name: "송파", isTransfer: false, transferTo: [] }, { name: "가락시장", isTransfer: true, transferTo: ["3호선"] }, { name: "문정", isTransfer: false, transferTo: [] }, { name: "장지", isTransfer: false, transferTo: [] }, { name: "복정", isTransfer: false, transferTo: [] }, { name: "남위례", isTransfer: false, transferTo: [] }, { name: "산성", isTransfer: false, transferTo: [] }, { name: "남한산성입구", isTransfer: false, transferTo: [] }, { name: "단대오거리", isTransfer: false, transferTo: [] }, { name: "신흥", isTransfer: false, transferTo: [] }, { name: "수진", isTransfer: false, transferTo: [] }, { name: "모란", isTransfer: false, transferTo: [] }
        ]
      },
      {
        line: "9호선",
        color: "#BDB092",
        stations: [
          { name: "개화", isTransfer: false, transferTo: [] }, { name: "김포공항", isTransfer: true, transferTo: ["5호선"] }, { name: "공항시장", isTransfer: false, transferTo: [] }, { name: "신방화", isTransfer: false, transferTo: [] }, { name: "마곡나루", isTransfer: false, transferTo: [] }, { name: "양천향교", isTransfer: false, transferTo: [] }, { name: "가양", isTransfer: false, transferTo: [] }, { name: "증미", isTransfer: false, transferTo: [] }, { name: "등촌", isTransfer: false, transferTo: [] }, { name: "염창", isTransfer: false, transferTo: [] }, { name: "신목동", isTransfer: false, transferTo: [] }, { name: "선유도", isTransfer: false, transferTo: [] }, { name: "당산", isTransfer: true, transferTo: ["2호선"] }, { name: "국회의사당", isTransfer: false, transferTo: [] }, { name: "여의도", isTransfer: true, transferTo: ["5호선"] }, { name: "샛강", isTransfer: false, transferTo: [] }, { name: "노량진", isTransfer: true, transferTo: ["1호선"] }, { name: "노들", isTransfer: false, transferTo: [] }, { name: "흑석", isTransfer: false, transferTo: [] }, { name: "동작", isTransfer: true, transferTo: ["4호선"] }, { name: "구반포", isTransfer: false, transferTo: [] }, { name: "신반포", isTransfer: false, transferTo: [] }, { name: "고속터미널", isTransfer: true, transferTo: ["3호선", "7호선"] }, { name: "사평", isTransfer: false, transferTo: [] }, { name: "신논현", isTransfer: false, transferTo: [] }, { name: "언주", isTransfer: false, transferTo: [] }, { name: "선정릉", isTransfer: false, transferTo: [] }, { name: "삼성중앙", isTransfer: false, transferTo: [] }, { name: "봉은사", isTransfer: false, transferTo: [] }, { name: "종합운동장", isTransfer: true, transferTo: ["2호선"] }, { name: "삼전", isTransfer: false, transferTo: [] }, { name: "석촌고분", isTransfer: false, transferTo: [] }, { name: "석촌", isTransfer: true, transferTo: ["8호선"] }, { name: "송파나루", isTransfer: false, transferTo: [] }, { name: "한성백제", isTransfer: false, transferTo: [] }, { name: "올림픽공원", isTransfer: true, transferTo: ["5호선(마천지선)"] }, { name: "둔촌오륜", isTransfer: false, transferTo: [] }, { name: "중앙보훈병원", isTransfer: false, transferTo: [] }
        ]
      }
    ];

    useEffect(() => {
        fetch('date_manifest.json').then(res => res.json()).then(dates => {
            if (dates.length > 0) setSelectedDate(dates.includes('2024-06-03') ? '2024-06-03' : dates[dates.length - 1]);
        });
    }, []);

    useEffect(() => {
        fetch('capital_area.geojson').then(res => res.json()).then(data => setGeoJson(data)).catch(() => console.log('No geojson found'));
    }, []);

    useEffect(() => {
        let cancelled = false;

        Promise.all([
            fetch('station_profiles.json').then(res => res.ok ? res.json() : { stations: {}, byCleanName: {} }).catch(() => ({ stations: {}, byCleanName: {} })),
            fetch('weather_events.json').then(res => res.ok ? res.json() : {}).catch(() => ({})),
            fetch('citydata_area_map.json').then(res => res.ok ? res.json() : {}).catch(() => ({})),
        ]).then(([profiles, events, areaMap]) => {
            if (cancelled) return;
            setStationProfiles(profiles.stations || {});
            setStationProfilesByCleanName(profiles.byCleanName || {});
            setWeatherEvents(events || {});
            setCityDataAreaMap(areaMap || {});
        });

        return () => { cancelled = true; };
    }, []);

    useEffect(() => {
        if (!selectedDate) return;
        const enrichStation = (station) => {
            const profile = stationProfiles[station.name] || stationProfilesByCleanName[cleanStationName(station.name)];
            if (!profile) return { ...station, station_type_label: getStationTypeLabel(station.station_type) };
            return {
                ...station,
                station_type: profile.stationType || station.station_type,
                station_type_label: profile.typeLabel || getStationTypeLabel(profile.stationType || station.station_type),
                station_profile: profile,
            };
        };

        fetch(`daily_data/${selectedDate}.json`).then(res => res.json()).then(dayData => {
            const hourlyWeatherEvents = weatherEvents[selectedDate] || Array.from({ length: 24 }, () => DRY_WEATHER_EVENT);
            const enrichedDayData = {
                ...dayData,
                hourly_weather_events: hourlyWeatherEvents,
            };
            setCurrentDay(enrichedDayData);
            const ds = (dayData.stations || []).map(enrichStation);
            setStations(ds);
            let dMaxC = 0, dMaxS = 0;
            ds.forEach(s => {
                const locMaxC = Math.max(...(s.hourly_congestion || [0]));
                const locMaxS = Math.max(...(s.hourly_stay?.map(Math.abs) || [0]));
                if (locMaxC > dMaxC) dMaxC = locMaxC;
                if (locMaxS > dMaxS) dMaxS = locMaxS;
            });
            setGlobalDailyMaxCongestion(dMaxC || 1);
            setGlobalDailyMaxStay(dMaxS || 1);
            if (selectedStation) setSelectedStation(ds.find(s => s.name === selectedStation.name) || null);
        });
        const d = new Date(selectedDate); d.setDate(d.getDate() - 7);
        fetch(`daily_data/${d.toISOString().split('T')[0]}.json`).then(res => res.json()).then(prevData => {
            if (selectedStation) {
                const match = prevData.stations.find(s => s.name === selectedStation.name);
                setLastWeekStation(match ? enrichStation(match) : null);
            }
        }).catch(() => setLastWeekStation(null));
    }, [selectedDate, selectedStation?.name, stationProfiles, stationProfilesByCleanName, weatherEvents]);

    const projection = useMemo(() => {
        if (stations.length === 0) return null;
        const featureCollection = {
            type: "FeatureCollection",
            features: stations.map(s => ({ type: "Feature", geometry: { type: "Point", coordinates: [s.x, s.y] } }))
        };
        return d3.geoMercator().fitExtent([[5, 5], [95, 95]], featureCollection);
    }, [stations]);

    const geoPathGenerator = useMemo(() => {
        if (!projection) return null;
        return d3.geoPath().projection(projection);
    }, [projection]);

    const geoPaths = useMemo(() => {
        if (!geoJson || !geoPathGenerator) return null;
        return geoJson.features.map((feature, idx) => {
            return <path key={`geo-${idx}`} d={geoPathGenerator(feature)} fill="#13212b" stroke="#2b4354" strokeWidth="0.4" vectorEffect="non-scaling-stroke" />;
        });
    }, [geoJson, geoPathGenerator]);

    const activeLineStationNames = useMemo(() => {
        if (selectedLine === 'All') return null;
        const names = new Set();
        SUBWAY_LINES.forEach(ld => {
            if (ld.line === selectedLine || ld.line.startsWith(selectedLine + '(')) {
                ld.stations.forEach(s => { names.add(cleanStationName(s.name)); });
            }
        });
        return names;
    }, [selectedLine]);

    const subwayPaths = useMemo(() => {
        if (stations.length === 0 || !projection) return [];
        const paths = [];
        const getCoord = (n) => {
            const cleanN = cleanStationName(n);
            const found = stations.find(s => cleanStationName(s.name) === cleanN);
            if (!found) return null;
            const [cx, cy] = projection([found.x, found.y]);
            return { x: cx, y: cy };
        };
        SUBWAY_LINES.forEach(lineInfo => {
            const segments = [];
            for (let i = 0; i < lineInfo.stations.length - 1; i++) {
                const s = getCoord(lineInfo.stations[i].name), e = getCoord(lineInfo.stations[i+1].name);
                if (s && e) segments.push({ x1: s.x, y1: s.y, x2: e.x, y2: e.y });
            }
            if (segments.length > 0) paths.push({ id: lineInfo.line, color: lineInfo.color, segments });
        });
        return paths;
    }, [stations, projection]);

    const subwayGeoSegments = useMemo(() => {
        if (stations.length === 0) return [];
        const stationLookup = new Map(stations.map((station) => [cleanStationName(station.name), station]));
        return SUBWAY_LINES.map((lineInfo) => {
            const segments = [];
            for (let i = 0; i < lineInfo.stations.length - 1; i += 1) {
                const startStation = stationLookup.get(cleanStationName(lineInfo.stations[i].name));
                const endStation = stationLookup.get(cleanStationName(lineInfo.stations[i + 1].name));
                if (!startStation || !endStation) continue;
                segments.push({
                    start: { lat: startStation.y, lng: startStation.x },
                    end: { lat: endStation.y, lng: endStation.x },
                });
            }
            return { id: lineInfo.line, color: lineInfo.color, segments };
        }).filter((lineInfo) => lineInfo.segments.length > 0);
    }, [SUBWAY_LINES, stations]);

    const handleMouseDown = (e) => { isDragging.current = true; lastMousePos.current = { x: e.clientX, y: e.clientY }; };
    const handleMouseMove = (e) => {
        if (!isDragging.current) return;
        const dx = e.clientX - lastMousePos.current.x, dy = e.clientY - lastMousePos.current.y;
        const sens = viewBox.w / 800;
        setViewBox(prev => ({ ...prev, x: prev.x - dx * sens, y: prev.y - dy * sens }));
        lastMousePos.current = { x: e.clientX, y: e.clientY };
    };
    const handleMouseUp = () => { isDragging.current = false; };
    const zoomScale = viewBox.w / 100;
    const handleZoom = (f) => setViewBox(p => {
        const nW = Math.max(5, Math.min(200, p.w * f)), nH = Math.max(5, Math.min(200, p.h * f));
        return { x: p.x + (p.w - nW) / 2, y: p.y + (p.h - nW * (p.h/p.w)) / 2, w: nW, h: nH };
    });
    const resetZoom = () => setViewBox({ x: 0, y: 0, w: 100, h: 100 });

    const formatNum = formatNumber;
    const dayInfo = currentDay || { hourly_weather: new Array(24).fill({temp:0, condition:'Clear'}), hourly_weather_events: Array.from({ length: 24 }, () => DRY_WEATHER_EVENT) };
    const hourlyWeatherEvents = dayInfo.hourly_weather_events || weatherEvents[selectedDate] || Array.from({ length: 24 }, () => DRY_WEATHER_EVENT);
    const currentWeather = dayInfo.hourly_weather?.[currentTime] || {temp: 0, condition: 'Clear'};
    const currentWeatherEvent = hourlyWeatherEvents[currentTime] || DRY_WEATHER_EVENT;
    const currentWeatherStyle = getWeatherStyle(currentWeatherEvent);
    const selectedAreaMap = selectedStation
        ? cityDataAreaMap[selectedStation.name] || cityDataAreaMap[cleanStationName(selectedStation.name)]
        : null;

    const weatherImpactStationIds = useMemo(() => {
        const focusedHour = weatherFocusHour ?? currentTime;
        const event = hourlyWeatherEvents[focusedHour] || DRY_WEATHER_EVENT;
        if (event.weatherImpact === 'Dry') return new Set();

        const scored = stations.map((station) => {
            const current = station.hourly_congestion?.[focusedHour] || 0;
            const prev = station.hourly_congestion?.[Math.max(0, focusedHour - 1)] || current;
            const next = station.hourly_congestion?.[Math.min(23, focusedHour + 1)] || current;
            return { id: station.id, delta: Math.abs(current - ((prev + next) / 2)) };
        });

        return new Set(scored.sort((a, b) => b.delta - a.delta).slice(0, 8).map((item) => item.id));
    }, [currentTime, hourlyWeatherEvents, stations, weatherFocusHour]);

    const getStationStyle = useCallback((s) => {
        const sCleanName = cleanStationName(s.name);
        const isT = selectedLine === 'All' || (activeLineStationNames && activeLineStationNames.has(sCleanName));
        let r = 1.05, c = "#ccff33", cat = ""; 
        if (viewMode === 'congestion') {
            const ratio = (s.hourly_congestion?.[currentTime] || 0) / globalDailyMaxCongestion;
            if (ratio > 0.7) { c = StateColors.Crowded; cat = "crowded"; }
            else if (ratio > 0.4) { c = StateColors.Moderate; cat = "moderate"; }
            else if (ratio > 0.1) { c = StateColors.Normal; cat = "normal"; }
            else { c = StateColors.Smooth; cat = "smooth"; }
        } else if (viewMode === 'inflowOutflow') {
            const diff = (s.hourly_inflow?.[currentTime] || 0) - (s.hourly_outflow?.[currentTime] || 0);
            if (diff > 0) { c = "rgba(230, 85, 13, 0.9)"; cat = "inflow"; }
            else { c = "rgba(49, 130, 189, 0.9)"; cat = "outflow"; }
        } else if (viewMode === 'train') {
            const satArr = Object.values(s.train_data || {}).map(v => Math.max(v.upper[currentTime], v.lower[currentTime]));
            const sat = satArr.length > 0 ? Math.max(...satArr) : 0;
            if (sat > 150) { c = "#8e44ad"; cat = "extreme"; }
            else if (sat > 100) { c = "#e74c3c"; cat = "heavy"; }
            else if (sat > 50) { c = "#e67e22"; cat = "normal"; }
            else { c = "#ccff33"; cat = "smooth"; }
        } else { 
            if (s.station_type === 'Business') { c = TYPE_COLORS.Business; cat = "business"; }
            else if (s.station_type === 'Residential') { c = TYPE_COLORS.Residential; cat = "residential"; }
            else if (s.station_type === 'Commercial Night') { c = TYPE_COLORS['Commercial Night']; cat = "commercial-night"; }
            else { c = TYPE_COLORS.Mixed; cat = "mixed"; }
        }

        const isLegendHighlighted = legendHighlight === cat;
        if (isLegendHighlighted) r *= 1.3;
        if (weatherImpactStationIds.has(s.id)) {
            r *= 1.35;
            if (viewMode === 'congestion') c = currentWeatherStyle.color;
            cat = cat || 'weather-impact';
        }

        return { radius: r, color: c, opacity: isT ? 1 : 0.05, interactive: isT, category: cat, isLegendHighlighted };
    }, [activeLineStationNames, currentTime, currentWeatherStyle.color, globalDailyMaxCongestion, legendHighlight, selectedLine, viewMode, weatherImpactStationIds]);

    const getStationMagnitude = useCallback((s) => {
        if (viewMode === 'congestion') {
            return Math.min(1, (s.hourly_congestion?.[currentTime] || 0) / globalDailyMaxCongestion);
        }
        if (viewMode === 'inflowOutflow') {
            const diff = Math.abs((s.hourly_inflow?.[currentTime] || 0) - (s.hourly_outflow?.[currentTime] || 0));
            return Math.min(1, diff / globalDailyMaxStay);
        }
        if (viewMode === 'train') {
            const satArr = Object.values(s.train_data || {}).map(v => Math.max(v.upper[currentTime], v.lower[currentTime]));
            return Math.min(1, (satArr.length > 0 ? Math.max(...satArr) : 0) / 180);
        }
        if (s.station_type === 'Commercial Night') return 0.62;
        return s.station_type === 'Mixed' ? 0.35 : 0.55;
    }, [currentTime, globalDailyMaxCongestion, globalDailyMaxStay, viewMode]);

    const maxCurrentRatio = stations.length > 0 ? Math.max(...stations.map(s => (s.hourly_congestion?.[currentTime] || 0) / globalDailyMaxCongestion)) : 0;
    let activeHighlightTier = null;
    if (viewMode === 'congestion') {
        if (maxCurrentRatio > 0.7) activeHighlightTier = 'crowded'; else if (maxCurrentRatio > 0.4) activeHighlightTier = 'moderate';
    }

    useEffect(() => {
        if (!isPlaying) return undefined;
        const timer = window.setInterval(() => {
            setCurrentTime((prev) => (prev >= 23 ? 0 : prev + 1));
        }, 850);
        return () => window.clearInterval(timer);
    }, [isPlaying]);

    useEffect(() => {
        setCompareStationName('');
    }, [selectedStation?.id]);

    useEffect(() => {
        if (!selectedStation) {
            setLiveStatus('unmapped');
            setLiveCityData(null);
            return undefined;
        }

        const areaMap = cityDataAreaMap[selectedStation.name] || cityDataAreaMap[cleanStationName(selectedStation.name)];
        if (!areaMap) {
            setLiveStatus('unmapped');
            setLiveCityData(null);
            return undefined;
        }

        if (!CITY_DATA_API_KEY) {
            setLiveStatus('missing-key');
            setLiveCityData(null);
            return undefined;
        }

        const controller = new AbortController();
        setLiveStatus('loading');
        setLiveCityData(null);

        const url = `http://openapi.seoul.go.kr:8088/${CITY_DATA_API_KEY}/json/citydata/1/5/${encodeURIComponent(areaMap.area)}`;
        fetch(url, { signal: controller.signal })
            .then((res) => {
                if (!res.ok) throw new Error('CITY_DATA_FETCH_FAILED');
                return res.json();
            })
            .then((payload) => {
                setLiveCityData(normalizeLiveCityData(payload));
                setLiveStatus('ready');
            })
            .catch((error) => {
                if (error.name === 'AbortError') return;
                setLiveStatus('unavailable');
                setLiveCityData(null);
            });

        return () => controller.abort();
    }, [cityDataAreaMap, selectedStation]);

    const overview = useMemo(() => {
        if (stations.length === 0 || !selectedDate) return null;
        const hourlyNetworkLoad = hours.map((hour) => stations.reduce((sum, station) => sum + (station.hourly_congestion?.[hour] || 0), 0));
        const peakHour = hourlyNetworkLoad.indexOf(Math.max(...hourlyNetworkLoad));
        const topStations = stations
            .map((station) => ({
                name: station.name,
                value: (station.hourly_congestion || []).reduce((sum, value) => sum + value, 0),
            }))
            .sort((a, b) => b.value - a.value)
            .slice(0, 5);
        const quietHours = hourlyNetworkLoad
            .map((value, hour) => ({ hour, value }))
            .filter(({ hour }) => hour >= 10 && hour <= 22)
            .sort((a, b) => a.value - b.value)
            .slice(0, 3)
            .map(({ hour }) => hour);
        const day = new Date(`${selectedDate}T00:00:00`).getDay();
        const weatherCounts = hourlyWeatherEvents.reduce((counts, event) => {
            counts[event.weatherImpact] = (counts[event.weatherImpact] || 0) + 1;
            return counts;
        }, {});
        const rainHours = (weatherCounts.Rain || 0) + (weatherCounts['Heavy Rain'] || 0);
        const snowHours = (weatherCounts.Snow || 0) + (weatherCounts['Snow Accumulation'] || 0);
        const weatherSummary = rainHours || snowHours
            ? `${rainHours} rain h / ${snowHours} snow h`
            : 'Dry all day';

        return {
            date: selectedDate,
            dayType: day === 0 || day === 6 ? 'Weekend' : 'Weekday',
            peakHour,
            topStations,
            quietHours,
            weatherSummary,
            hourlyNetworkLoad,
        };
    }, [hourlyWeatherEvents, selectedDate, stations]);

    const compareStation = useMemo(() => {
        if (!compareStationName) return null;
        const target = cleanStationName(compareStationName);
        return stations.find((station) => station.name === compareStationName || cleanStationName(station.name) === target) || null;
    }, [compareStationName, stations]);

    // Custom filtering logic moved after dayInfo definition
    useEffect(() => {
        if (!isCustomOpen) return;
        
        let results = [];
        const targetTemp = parseFloat(customFilters.temp);
        const targetTime = customFilters.time !== '' ? parseInt(customFilters.time) : null;
        const targetLine = customFilters.line;

        let matchingHours = [];
        if (dayInfo && dayInfo.hourly_weather) {
            dayInfo.hourly_weather.forEach((w, h) => {
                let match = true;
                if (targetTime !== null && h !== targetTime) match = false;
                if (!isNaN(targetTemp)) {
                    const baseTemp = Math.floor(targetTemp);
                    if (w.temp < baseTemp || w.temp >= baseTemp + 1) match = false;
                }
                if (match) matchingHours.push(h);
            });
        }

        if (matchingHours.length > 0) {
            stations.forEach(s => {
                const sLines = s.lines || [];
                const lineMatch = targetLine === 'All' || sLines.some(l => l.includes(targetLine));
                if (lineMatch) {
                    matchingHours.forEach(hour => {
                        results.push({
                            ...s,
                            matchingHour: hour,
                            uniqueId: `${s.id}-${hour}`
                        });
                    });
                }
            });
            setCustomResults(results);
        } else {
            setCustomResults([]);
        }
    }, [customFilters, stations, dayInfo, isCustomOpen]);

    const getBehavior = (s) => {
        const getF = (h1, h2) => {
            let f = 0;
            for(let i=h1; i<h2; i++) f += (s.hourly_inflow?.[i] || 0) - (s.hourly_outflow?.[i] || 0);
            return f;
        };
        return { morning: getF(9,12) > 0 ? "Inflow" : "Outflow", noon: getF(12,18) > 0 ? "Inflow" : "Outflow", evening: getF(18,24) > 0 ? "Inflow" : "Outflow" };
    };

    const executeSearch = () => {
        if (!searchQuery) return;
        const q = searchQuery.replace(/역$/, '').trim();
        const found = stations.find(s => {
            const cleanS = cleanStationName(s.name);
            return cleanS === q || s.name.includes(q);
        });
        if (found) { setSelectedStation(found); setSearchQuery(''); } else { alert('Station not found.'); }
    };

    return (
        <div className="app-container">
            <header className="header-bar" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', position: 'relative', zIndex: 1000 }}>
                <div className="logo-title" style={{ flex: '1' }}><h1>Seoul Subway Movement Flow</h1></div>
                <div className="search-wrapper" style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', zIndex: 100 }}>
                    <div className="search-container" style={{ display: 'flex', alignItems: 'center', background: '#fff', padding: '6px 15px', borderRadius: '20px', border: '2px solid #000', gap: '10px' }}>
                        <input type="text" placeholder="Search station, e.g. Gangnam" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && executeSearch()} style={{ background: 'transparent', border: 'none', color: '#000', outline: 'none', width: '200px', fontSize: '14px' }} />
                        <span style={{ cursor: 'pointer', color: '#000' }} onClick={executeSearch}>🔍</span>
                        <div style={{ width: '1px', height: '20px', background: '#ddd' }}></div>
                        <button className={`custom-toggle-btn ${isCustomOpen ? 'active' : ''}`} onClick={() => setIsCustomOpen(!isCustomOpen)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '14px', fontWeight: 'bold', color: isCustomOpen ? '#007aff' : '#666' }}>Custom</button>
                    </div>

                    {isCustomOpen && (
                        <div className="custom-filter-panel" style={{ position: 'absolute', top: '50px', left: '50%', transform: 'translateX(-50%)', background: '#fff', padding: '20px', borderRadius: '15px', boxShadow: '0 10px 30px rgba(0,0,0,0.15)', border: '1px solid #eee', width: '450px' }}>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', marginBottom: '15px' }}>
                                <div className="filter-group">
                                    <label style={{ fontSize: '11px', fontWeight: 'bold', color: '#7f8c8d', display: 'block', marginBottom: '5px' }}>Date</label>
                                    <input type="date" value={selectedDate} onChange={e => setSelectedDate(e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid #ddd' }} />
                                </div>
                                <div className="filter-group">
                                    <label style={{ fontSize: '11px', fontWeight: 'bold', color: '#7f8c8d', display: 'block', marginBottom: '5px' }}>Time (0-23)</label>
                                    <input type="number" min="0" max="23" placeholder="All" value={customFilters.time} onChange={e => setCustomFilters({...customFilters, time: e.target.value})} style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid #ddd' }} />
                                </div>
                                <div className="filter-group">
                                    <label style={{ fontSize: '11px', fontWeight: 'bold', color: '#7f8c8d', display: 'block', marginBottom: '5px' }}>Temperature (°C)</label>
                                    <input type="number" placeholder="Enter Temp" value={customFilters.temp} onChange={e => setCustomFilters({...customFilters, temp: e.target.value})} style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid #ddd' }} />
                                </div>
                                <div className="filter-group">
                                    <label style={{ fontSize: '11px', fontWeight: 'bold', color: '#7f8c8d', display: 'block', marginBottom: '5px' }}>Line</label>
                                    <select value={customFilters.line} onChange={e => setCustomFilters({...customFilters, line: e.target.value})} style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid #ddd' }}>
                                        <option value="All">All Lines</option>
                                        {[1,2,3,4,5,6,7,8,9].map(n => <option key={n} value={`${n}호선`}>{n}호선</option>)}
                                    </select>
                                </div>
                            </div>

                            <div className="custom-results-list" style={{ maxHeight: '200px', overflowY: 'auto', borderTop: '1px solid #eee', paddingTop: '10px' }}>
                                <h4 style={{ fontSize: '12px', color: '#7f8c8d', marginBottom: '8px' }}>Matching Stations ({customResults.length})</h4>
                                {customResults.length > 0 ? (
                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px' }}>
                                        {customResults.map(s => (
                                            <div key={s.uniqueId} className="result-item" onClick={() => { setSelectedStation(s); setCurrentTime(s.matchingHour); }} style={{ padding: '8px 12px', borderRadius: '6px', fontSize: '12px', cursor: 'pointer', background: (selectedStation?.id === s.id && currentTime === s.matchingHour) ? '#f0f7ff' : '#f8f9fa', border: (selectedStation?.id === s.id && currentTime === s.matchingHour) ? '1px solid #007aff' : '1px solid transparent' }}>
                                                {s.name} <span style={{ fontSize: '10px', color: '#666' }}>({s.lines?.[0]})</span> <span style={{ fontSize: '10px', color: '#007aff', fontWeight: 'bold' }}>{s.matchingHour}h</span>
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <p style={{ fontSize: '12px', color: '#999', textAlign: 'center', padding: '20px 0' }}>No stations match these filters.</p>
                                )}
                            </div>
                        </div>
                    )}
                </div>
                <div className="header-right" style={{ flex: '1', textAlign: 'right' }}></div>
            </header>
            <main className="main-content">
                <div className="left-section">
                    <div className="control-panel">
                        <div className="input-group"><label>Analysis Date</label><input type="date" value={selectedDate} min="2023-01-01" max="2024-12-31" onChange={e => setSelectedDate(e.target.value)} /></div>
                        <div className="mode-buttons">
                            <button className={viewMode === 'congestion' ? 'active' : ''} onClick={() => setViewMode('congestion')}>Station Load</button>
                            <button className={viewMode === 'inflowOutflow' ? 'active' : ''} onClick={() => setViewMode('inflowOutflow')}>Flow Direction</button>
                            <button className={viewMode === 'stationType' ? 'active' : ''} onClick={() => setViewMode('stationType')}>Station Pattern</button>
                            <button className={viewMode === 'train' ? 'active' : ''} onClick={() => setViewMode('train')}>Train Saturation</button>
                        </div>
                        <div className="surface-buttons">
                            <button className={mapSurface === 'naver' ? 'active' : ''} onClick={() => setMapSurface('naver')}>NAVER</button>
                            <button className={mapSurface === 'diagram' ? 'active' : ''} onClick={() => setMapSurface('diagram')}>Diagram</button>
                        </div>
                    </div>
                    <div className="line-filter">
                        <div className={`line-chip ${selectedLine === 'All' ? 'active' : ''}`} onClick={() => { setSelectedLine('All'); setSelectedStation(null); }} style={{backgroundColor: selectedLine === 'All' ? '#2c3e50' : '#fff', color: selectedLine === 'All' ? '#fff' : '#7f8c8d'}}>ALL</div>
                        {Object.keys(lineColors).map(l => (
                            <div key={l} className={`line-chip ${selectedLine === l ? 'active' : ''}`} onClick={() => { setSelectedLine(p => p === l ? 'All' : l); setSelectedStation(null); }}
                                 style={{ borderLeft: `4px solid ${lineColors[l]}`, backgroundColor: selectedLine === l ? lineColors[l] : '#fff', color: selectedLine === l ? '#fff' : '#7f8c8d' }}>{l}</div>
                        ))}
                    </div>
                    <div className="map-view">
                        <div
                            className={`map-svg-container ${mapSurface === 'naver' ? 'naver-surface' : 'diagram-surface'}`}
                            onMouseDown={mapSurface === 'diagram' ? handleMouseDown : undefined}
                            onMouseMove={mapSurface === 'diagram' ? handleMouseMove : undefined}
                            onMouseUp={mapSurface === 'diagram' ? handleMouseUp : undefined}
                            onMouseLeave={mapSurface === 'diagram' ? handleMouseUp : undefined}
                        >
                            {mapSurface === 'naver' ? (
                                <NaverMapGate
                                     stations={stations}
                                     selectedLine={selectedLine}
                                     activeLineStationNames={activeLineStationNames}
                                     routeSegments={subwayGeoSegments}
                                     selectedStation={selectedStation}
                                    hoveredStation={hoveredStation}
                                    setSelectedStation={setSelectedStation}
                                    setHoveredStation={setHoveredStation}
                                    getStationStyle={getStationStyle}
                                    getStationMagnitude={getStationMagnitude}
                                    onClearSelection={() => { setSelectedStation(null); setLegendHighlight(null); }}
                                />
                            ) : (
                                <>
                                    <div className="zoom-controls" onClick={e => e.stopPropagation()}>
                                        <button onClick={() => handleZoom(0.7)}>+</button><button onClick={() => handleZoom(1.4)}>-</button><button onClick={resetZoom}>⟲</button>
                                    </div>
                                    <svg width="100%" height="100%" viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`} preserveAspectRatio="xMidYMid meet" onClick={() => { setSelectedStation(null); setLegendHighlight(null); }}>
                                        <rect x="-1000" y="-1000" width="2000" height="2000" fill="#0d1720" />
                                        {geoPaths}
                                        {subwayPaths.map(p => {
                                            const isVis = selectedLine === 'All' || p.id === selectedLine || p.id.startsWith(selectedLine + '(');
                                            return (<g key={p.id} opacity={isVis ? 0.6 : 0.05}>{p.segments.map((s, i) => <line key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke={p.color} strokeWidth={0.45 * zoomScale} />)}</g>);
                                        })}
                                        {stations.map(s => {
                                            if (s.id === hoveredStation?.id || s.id === selectedStation?.id || !projection) return null;
                                            const st = getStationStyle(s); const r = st.radius * zoomScale;
                                            const ratio = (s.hourly_congestion?.[currentTime] || 0) / globalDailyMaxCongestion;
                                            const isAutoHighlighted = viewMode === 'congestion' && ((activeHighlightTier === 'crowded' && ratio > 0.7) || (activeHighlightTier === 'moderate' && ratio > 0.4 && ratio <= 0.7));
                                            const shouldShowLabel = (selectedLine !== 'All' && st.interactive) || isAutoHighlighted || st.isLegendHighlighted;
                                             const [cx, cy] = projection([s.x, s.y]);
                                             return (
                                                 <g key={s.id} className="diagram-station-node" opacity={st.opacity} style={{ pointerEvents: st.interactive ? 'auto' : 'none', '--node-color': st.color }}>
                                                     <circle className="diagram-station-glow" cx={cx} cy={cy} r={r * 2.6} fill={st.color} />
                                                     <circle className="diagram-station-ring" cx={cx} cy={cy} r={r * 1.35} fill="none" stroke={st.color} strokeWidth={0.18 * zoomScale} />
                                                     <circle className="diagram-station-dot" cx={cx} cy={cy} r={Math.max(0.45 * zoomScale, r * 0.72)} fill={st.color} style={{ cursor: 'pointer' }} onMouseEnter={() => setHoveredStation(s)} onMouseLeave={() => setHoveredStation(null)} onClick={(e) => { e.stopPropagation(); setSelectedStation(s); }} />
                                                     {shouldShowLabel && <text x={cx} y={cy - r - (0.5 * zoomScale)} className="station-label" textAnchor="middle" style={{fontSize: `${1.8 * zoomScale}px`, fontWeight: 'bold'}}>{s.name}</text>}
                                                 </g>
                                             );
                                        })}
                                        {(() => {
                                            const items = [];
                                            if (selectedStation) items.push({ s: selectedStation, isSelected: true });
                                            if (hoveredStation && (!selectedStation || hoveredStation.id !== selectedStation.id)) {
                                                items.push({ s: hoveredStation, isSelected: false });
                                            }
                                            return items.map(({ s, isSelected }) => {
                                                if (!s || !projection) return null; 
                                                const st = getStationStyle(s);
                                                 const r = (isSelected ? st.radius * 2 : st.radius * 1.5) * zoomScale;
                                                 const [cx, cy] = projection([s.x, s.y]);
                                                 return (
                                                     <g key={isSelected ? 'selected' : 'hovered'} className={`diagram-station-node ${isSelected ? 'is-selected' : 'is-hovered'}`} opacity={1} style={{ pointerEvents: 'auto', '--node-color': st.color }}>
                                                         <circle className="diagram-station-glow" cx={cx} cy={cy} r={r * 2.9} fill={st.color} />
                                                         <circle className="diagram-station-ring" cx={cx} cy={cy} r={r * 1.35} fill="none" stroke={st.color} strokeWidth={0.22 * zoomScale} />
                                                         <circle className="diagram-station-dot" cx={cx} cy={cy} r={Math.max(0.55 * zoomScale, r * 0.72)} fill={st.color} stroke="#fff" strokeWidth={0.2 * zoomScale} style={{ cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); setSelectedStation(s); }} />
                                                         <text x={cx} y={cy - r - 1.0 * zoomScale} className="station-label" textAnchor="middle" style={{fontSize: `${1.8 * zoomScale}px`, fontWeight: 'bold'}}>{s.name}</text>
                                                     </g>
                                                 );
                                            });
                                        })()}
                                    </svg>
                                </>
                            )}
                             <div className="context-overlay" onClick={e => e.stopPropagation()}>
                                 <div className="weather-info">{selectedDate} ({hourLabel(currentTime)})</div>
                                 <div className="weather-info"><span>{currentWeather.temp}C, {currentWeather.condition}</span><strong>{currentWeatherStyle.label}</strong></div>
                                 {(currentWeatherEvent.rainMm > 0 || currentWeatherEvent.snowCm > 0 || currentWeatherEvent.newSnowCm > 0) && (
                                     <div className="weather-info subtle-weather">
                                         <span>Rain {currentWeatherEvent.rainMm}mm</span>
                                         <span>Snow {currentWeatherEvent.snowCm}cm</span>
                                     </div>
                                 )}
                             </div>
                             {hoveredStation && !selectedStation && (
                                 <div className="hover-preview-panel" onClick={e => e.stopPropagation()}>
                                     <strong>{hoveredStation.name}</strong>
                                     <span>{getStationTypeLabel(hoveredStation.station_type)}</span>
                                     <RhythmBand values={hoveredStation.hourly_congestion || []} currentTime={currentTime} weatherEvents={hourlyWeatherEvents} onHourChange={setCurrentTime} compact />
                                 </div>
                             )}
                            <div className="map-legend" onClick={e => e.stopPropagation()}>
                                <span className="legend-title">{viewMode === 'congestion' ? 'Station Load' : viewMode === 'inflowOutflow' ? 'Flow Direction' : viewMode === 'train' ? 'Train Saturation' : 'Station Pattern'}</span>
                                {viewMode === 'congestion' ? (
                                    <>
                                        <div className={`legend-item ${legendHighlight === 'crowded' ? 'active' : ''}`} onClick={() => setLegendHighlight(p => p === 'crowded' ? null : 'crowded')} style={{cursor:'pointer', padding:'2px 5px', borderRadius:'4px', transition:'all 0.2s', background: legendHighlight === 'crowded' ? 'rgba(0,0,0,0.05)' : 'transparent'}}>
                                            <div className="color-box" style={{backgroundColor: StateColors.Crowded}}></div><span>Crowded (70%+)</span>
                                        </div>
                                        <div className={`legend-item ${legendHighlight === 'moderate' ? 'active' : ''}`} onClick={() => setLegendHighlight(p => p === 'moderate' ? null : 'moderate')} style={{cursor:'pointer', padding:'2px 5px', borderRadius:'4px', transition:'all 0.2s', background: legendHighlight === 'moderate' ? 'rgba(0,0,0,0.05)' : 'transparent'}}>
                                            <div className="color-box" style={{backgroundColor: StateColors.Moderate}}></div><span>Moderate (40~70%)</span>
                                        </div>
                                        <div className={`legend-item ${legendHighlight === 'normal' ? 'active' : ''}`} onClick={() => setLegendHighlight(p => p === 'normal' ? null : 'normal')} style={{cursor:'pointer', padding:'2px 5px', borderRadius:'4px', transition:'all 0.2s', background: legendHighlight === 'normal' ? 'rgba(0,0,0,0.05)' : 'transparent'}}>
                                            <div className="color-box" style={{backgroundColor: StateColors.Normal}}></div><span>Normal (10~40%)</span>
                                        </div>
                                        <div className={`legend-item ${legendHighlight === 'smooth' ? 'active' : ''}`} onClick={() => setLegendHighlight(p => p === 'smooth' ? null : 'smooth')} style={{cursor:'pointer', padding:'2px 5px', borderRadius:'4px', transition:'all 0.2s', background: legendHighlight === 'smooth' ? 'rgba(0,0,0,0.05)' : 'transparent'}}>
                                            <div className="color-box" style={{backgroundColor: StateColors.Smooth}}></div><span>Smooth (0~10%)</span>
                                        </div>
                                    </>
                                ) : viewMode === 'train' ? (
                                    <>
                                        <div className={`legend-item ${legendHighlight === 'extreme' ? 'active' : ''}`} onClick={() => setLegendHighlight(p => p === 'extreme' ? null : 'extreme')} style={{cursor:'pointer', padding:'2px 5px', borderRadius:'4px', transition:'all 0.2s', background: legendHighlight === 'extreme' ? 'rgba(0,0,0,0.05)' : 'transparent'}}>
                                            <div className="color-box" style={{backgroundColor: '#8e44ad'}}></div><span>Extreme (150%+)</span>
                                        </div>
                                        <div className={`legend-item ${legendHighlight === 'heavy' ? 'active' : ''}`} onClick={() => setLegendHighlight(p => p === 'heavy' ? null : 'heavy')} style={{cursor:'pointer', padding:'2px 5px', borderRadius:'4px', transition:'all 0.2s', background: legendHighlight === 'heavy' ? 'rgba(0,0,0,0.05)' : 'transparent'}}>
                                            <div className="color-box" style={{backgroundColor: '#e74c3c'}}></div><span>Heavy (100~150%)</span>
                                        </div>
                                        <div className={`legend-item ${legendHighlight === 'normal' ? 'active' : ''}`} onClick={() => setLegendHighlight(p => p === 'normal' ? null : 'normal')} style={{cursor:'pointer', padding:'2px 5px', borderRadius:'4px', transition:'all 0.2s', background: legendHighlight === 'normal' ? 'rgba(0,0,0,0.05)' : 'transparent'}}>
                                            <div className="color-box" style={{backgroundColor: '#e67e22'}}></div><span>Normal (50~100%)</span>
                                        </div>
                                        <div className={`legend-item ${legendHighlight === 'smooth' ? 'active' : ''}`} onClick={() => setLegendHighlight(p => p === 'smooth' ? null : 'smooth')} style={{cursor:'pointer', padding:'2px 5px', borderRadius:'4px', transition:'all 0.2s', background: legendHighlight === 'smooth' ? 'rgba(0,0,0,0.05)' : 'transparent'}}>
                                            <div className="color-box" style={{backgroundColor: '#ccff33'}}></div><span>Smooth (~50%)</span>
                                        </div>
                                    </>
                                ) : viewMode === 'inflowOutflow' ? (
                                    <>
                                        <div className={`legend-item ${legendHighlight === 'inflow' ? 'active' : ''}`} onClick={() => setLegendHighlight(p => p === 'inflow' ? null : 'inflow')} style={{cursor:'pointer', padding:'2px 5px', borderRadius:'4px', transition:'all 0.2s', background: legendHighlight === 'inflow' ? 'rgba(0,0,0,0.05)' : 'transparent'}}>
                                            <div className="color-box" style={{backgroundColor: '#e6550d'}}></div><span>Inflow Dominant</span>
                                        </div>
                                        <div className={`legend-item ${legendHighlight === 'outflow' ? 'active' : ''}`} onClick={() => setLegendHighlight(p => p === 'outflow' ? null : 'outflow')} style={{cursor:'pointer', padding:'2px 5px', borderRadius:'4px', transition:'all 0.2s', background: legendHighlight === 'outflow' ? 'rgba(0,0,0,0.05)' : 'transparent'}}>
                                            <div className="color-box" style={{backgroundColor: '#3182bd'}}></div><span>Outflow Dominant</span>
                                        </div>
                                    </>
                                ) : (
                                    <>
                                        <div className={`legend-item ${legendHighlight === 'business' ? 'active' : ''}`} onClick={() => setLegendHighlight(p => p === 'business' ? null : 'business')} style={{cursor:'pointer', padding:'2px 5px', borderRadius:'4px', transition:'all 0.2s', background: legendHighlight === 'business' ? 'rgba(0,0,0,0.05)' : 'transparent'}}>
                                            <div className="color-box" style={{backgroundColor: TYPE_COLORS.Business}}></div><span>Morning Inflow</span>
                                        </div>
                                        <div className={`legend-item ${legendHighlight === 'residential' ? 'active' : ''}`} onClick={() => setLegendHighlight(p => p === 'residential' ? null : 'residential')} style={{cursor:'pointer', padding:'2px 5px', borderRadius:'4px', transition:'all 0.2s', background: legendHighlight === 'residential' ? 'rgba(0,0,0,0.05)' : 'transparent'}}>
                                            <div className="color-box" style={{backgroundColor: TYPE_COLORS.Residential}}></div><span>Morning Outflow</span>
                                        </div>
                                        <div className={`legend-item ${legendHighlight === 'commercial-night' ? 'active' : ''}`} onClick={() => setLegendHighlight(p => p === 'commercial-night' ? null : 'commercial-night')} style={{cursor:'pointer', padding:'2px 5px', borderRadius:'4px', transition:'all 0.2s', background: legendHighlight === 'commercial-night' ? 'rgba(0,0,0,0.05)' : 'transparent'}}>
                                            <div className="color-box" style={{backgroundColor: TYPE_COLORS['Commercial Night']}}></div><span>Commercial Night</span>
                                        </div>
                                        <div className={`legend-item ${legendHighlight === 'mixed' ? 'active' : ''}`} onClick={() => setLegendHighlight(p => p === 'mixed' ? null : 'mixed')} style={{cursor:'pointer', padding:'2px 5px', borderRadius:'4px', transition:'all 0.2s', background: legendHighlight === 'mixed' ? 'rgba(0,0,0,0.05)' : 'transparent'}}>
                                            <div className="color-box" style={{backgroundColor: TYPE_COLORS.Mixed}}></div><span>Mixed Flow</span>
                                        </div>
                                    </>
                                )}
                            </div>
                            {selectedStation && (
                                <div className="metadata-panel" onClick={e => e.stopPropagation()}>
                                    <div className="meta-row"><strong>STATION</strong> <span>{selectedStation.name}</span></div>
                                    <div className="meta-row"><strong>LINES</strong> <span>{selectedStation.lines?.join(', ')}</span></div>
                                    <hr/><div className="behavior-item">Morning Flow: {getBehavior(selectedStation).morning}</div>
                                    <div className="behavior-item">Noon Flow: {getBehavior(selectedStation).noon}</div>
                                    <div className="behavior-item">Evening Flow: {getBehavior(selectedStation).evening}</div>
                                </div>
                            )}
                        </div>
                        <div className="time-slider">
                            <div className="time-slider-head">
                                <button className={`play-button ${isPlaying ? 'active' : ''}`} onClick={() => setIsPlaying((prev) => !prev)}>
                                    {isPlaying ? 'Pause' : 'Play Day'}
                                </button>
                                <div><span>Time</span><strong>{hourLabel(currentTime)}</strong></div>
                                <div><span>Weather</span><strong>{currentWeatherStyle.label}</strong></div>
                            </div>
                            <input type="range" min="0" max="23" value={currentTime} onChange={e => { setCurrentTime(Number(e.target.value)); setWeatherFocusHour(null); }} />
                            <WeatherImpactTimeline
                                events={hourlyWeatherEvents}
                                values={overview?.hourlyNetworkLoad || []}
                                currentTime={currentTime}
                                onHourChange={(hour, event) => {
                                    setCurrentTime(hour);
                                    setWeatherFocusHour(event.weatherImpact === 'Dry' ? null : hour);
                                }}
                            />
                        </div>
                    </div>
                </div>
                <div className="right-section" onClick={e => e.stopPropagation()}>
                    <div className="dashboard-panel">
                        {selectedStation ? (
                            <div className="dashboard-content">
                                <LiveNowCard station={selectedStation} areaMap={selectedAreaMap} status={liveStatus} data={liveCityData} />
                                <div className="station-header">
                                    <div>
                                        <h3>{selectedStation.name}</h3>
                                        <span>{selectedStation.lines?.join(', ')}</span>
                                    </div>
                                    <span className="type-badge" style={{ backgroundColor: TYPE_COLORS[selectedStation.station_type] || TYPE_COLORS.Mixed }}>{getStationTypeLabel(selectedStation.station_type)}</span>
                                </div>
                                <div className="chart-container compact-chart">
                                    <h4>24h Rhythm Band</h4>
                                    <RhythmBand values={selectedStation.hourly_congestion || []} currentTime={currentTime} weatherEvents={hourlyWeatherEvents} onHourChange={setCurrentTime} />
                                </div>
                                <div className="chart-container compact-chart">
                                    <h4>Flow Balance Diverging Bar</h4>
                                    <FlowBalanceBars station={selectedStation} currentTime={currentTime} onHourChange={setCurrentTime} />
                                </div>
                                <div className="chart-container compact-chart">
                                    <h4>Weather Impact Timeline</h4>
                                    <WeatherImpactTimeline
                                        events={hourlyWeatherEvents}
                                        values={selectedStation.hourly_congestion || []}
                                        currentTime={currentTime}
                                        onHourChange={(hour, event) => {
                                            setCurrentTime(hour);
                                            setWeatherFocusHour(event.weatherImpact === 'Dry' ? null : hour);
                                        }}
                                    />
                                </div>
                                <div className="chart-container">
                                    <h4>Station Load vs Last Week</h4>
                                    <h5>Total hourly entries and exits</h5>
                                    <svg viewBox="0 0 350 225" className="chart-svg">
                                        <text x="180" y="215" fontSize="10" fill="#95a5a6" textAnchor="middle">Time (Hour)</text>
                                        <text x="5" y="105" fontSize="10" fill="#95a5a6" textAnchor="middle" transform="rotate(-90 5,105)">Congestion</text>
                                        {(() => {
                                            const data = selectedStation.hourly_congestion || []; const max = globalDailyMaxCongestion; 
                                            const getX = i => 45 + i * (285 / 23); const getY = v => 170 - (v / max) * 130;
                                            const prevData = lastWeekStation?.hourly_congestion;
                                            const ticks = []; const step = max >= 20000 ? 4000 : max >= 10000 ? 2000 : max >= 5000 ? 1000 : 500;
                                            for(let v=0; v<=max; v+=step) ticks.push(v);
                                            if (ticks[ticks.length-1] < max * 0.9) ticks.push(max);
                                            return (<><line x1="45" y1="40" x2="45" y2="170" stroke="#bdc3c7" /><line x1="45" y1="170" x2="330" y2="170" stroke="#bdc3c7" />
                                                {ticks.map(v => (<text key={v} x="40" y={getY(v) + 4} fontSize="8" fill="#7f8c8d" textAnchor="end">{formatNum(v)}</text>))}
                                                {[0, 6, 12, 18, 23].map(h => (<text key={h} x={getX(h)} y="185" fontSize="10" fill="#7f8c8d" textAnchor="middle">{h}h</text>))}
                                                {prevData && <polyline points={prevData.map((v, i) => `${getX(i)},${getY(v)}`).join(' ')} fill="none" stroke="#bdc3c7" strokeWidth="1" strokeDasharray="3" />}
                                                <polyline points={data.map((v, i) => `${getX(i)},${getY(v)}`).join(' ')} fill="none" stroke="#2c3e50" strokeWidth="2" />
                                                {data.map((v, h) => (<g key={h}><circle cx={getX(h)} cy={getY(v)} r="2.5" fill="#2c3e50" /><rect x={getX(h)-5} y="40" width="10" height="130" fill="transparent" onMouseEnter={() => { const pV = prevData ? prevData[h] : 0; const diffVal = pV > 0 ? ((v-pV)/pV*100).toFixed(1) : 'N/A'; setCongestTooltip({ x: getX(h), y: getY(v), h, val: v, prev: pV, diff: diffVal }); }} onMouseLeave={() => setCongestTooltip(null)} onClick={() => setCurrentTime(h)} style={{cursor:'pointer'}} /></g>))}
                                                <line x1={getX(currentTime)} y1="40" x2={getX(currentTime)} y2="170" stroke="#e74c3c" strokeDasharray="3" />
                                                {congestTooltip && (() => {
                                                    let tX = congestTooltip.x - 65; if (tX < 5) tX = 5; if (tX + 130 > 345) tX = 345 - 130;
                                                    let tY = congestTooltip.y - 85; if (tY < 5) tY = congestTooltip.y + 15;
                                                    return (<g><rect x={tX} y={tY} width="130" height="70" fill="rgba(26,37,47,0.95)" rx="6" /><text x={tX + 10} y={tY + 17} fill="#bdc3c7" fontSize="8">Today ({congestTooltip.h}h):</text><text x={tX + 120} y={tY + 17} fill="#fff" fontSize="9" fontWeight="bold" textAnchor="end">{formatNum(congestTooltip.val)}</text><text x={tX + 10} y={tY + 35} fill="#bdc3c7" fontSize="8">Last Week:</text><text x={tX + 120} y={tY + 35} fill="#fff" fontSize="9" textAnchor="end">{formatNum(congestTooltip.prev)}</text><text x={tX + 10} y={tY + 53} fill="#bdc3c7" fontSize="8">Change:</text><text x={tX + 120} y={tY + 53} fill={congestTooltip.diff !== 'N/A' && parseFloat(congestTooltip.diff) > 0 ? "#ff7675" : "#55efc4"} fontSize="9" fontWeight="bold" textAnchor="end">{congestTooltip.diff}%</text></g>);
                                                })()}
                                            </>);
                                        })()}
                                    </svg>
                                </div>
                                <div className="chart-container">
                                    <h4>Stay Tendency</h4>
                                    <h5>Inflow minus outflow</h5>
                                    <svg viewBox="0 0 350 225" className="chart-svg">
                                        <text x="180" y="215" fontSize="10" fill="#95a5a6" textAnchor="middle">Time (Hour)</text>
                                        <text x="10" y="105" fontSize="10" fill="#95a5a6" textAnchor="middle" transform="rotate(-90 10,105)">Flow Balance</text>
                                        {(() => {
                                            const data = selectedStation.hourly_stay || []; const maxAbsVal = globalDailyMaxStay; 
                                            const getX = i => 45 + i * (285 / 23); const getY = v => 105 - (v / maxAbsVal) * 65;
                                            const ticks = []; const step = maxAbsVal >= 20000 ? 4000 : maxAbsVal >= 10000 ? 2000 : maxAbsVal >= 5000 ? 1000 : 500;
                                            for(let v = -Math.floor(maxAbsVal/step)*step; v <= maxAbsVal; v += step) ticks.push(v);
                                            return (<><line x1="45" y1="40" x2="45" y2="170" stroke="#bdc3c7" /><line x1="45" y1="105" x2="330" y2="105" stroke="#bdc3c7" strokeDasharray="4" />
                                                {ticks.map(v => (<text key={v} x="40" y={getY(v) + 4} fontSize="8" fill="#7f8c8d" textAnchor="end">{v > 0 ? '+' : ''}{formatNum(v)}</text>))}
                                                {[0, 6, 12, 18, 23].map(h => (<text key={h} x={getX(h)} y="185" fontSize="10" fill="#7f8c8d" textAnchor="middle">{h}h</text>))}
                                                <polyline points={data.map((v, i) => `${getX(i)},${getY(v)}`).join(' ')} fill="none" stroke="#2980b9" strokeWidth="2" />
                                                <line x1={getX(currentTime)} y1="40" x2={getX(currentTime)} y2="170" stroke="#e74c3c" strokeDasharray="3" />
                                                <circle cx={getX(currentTime)} cy={getY(data[currentTime])} r="3" fill="#e74c3c" />
                                                <text x={getX(currentTime) + 4} y={getY(data[currentTime]) - 4} fill="#e74c3c" fontSize="11" fontWeight="bold" textAnchor="start">{data[currentTime] > 0 ? '+' : ''}{formatNum(data[currentTime])}</text>
                                            </>);
                                        })()}
                                    </svg>
                                </div>
                                <div className="chart-container">
                                    <h4>Hourly Temperature vs. Congestion</h4>
                                    <svg viewBox="0 0 350 235" className="chart-svg">
                                        <text x="185" y="225" fontSize="10" fill="#95a5a6" textAnchor="middle">Temperature (°C)</text>
                                        <text x="10" y="110" fontSize="10" fill="#95a5a6" textAnchor="middle" transform="rotate(-90 10,110)">Congestion</text>
                                        {(() => {
                                            const weather = dayInfo.hourly_weather || []; const congs = selectedStation.hourly_congestion || [];
                                            const temps = weather.map(w => w.temp); const minT = Math.min(...temps); const maxT = Math.max(...temps); 
                                            const localMaxC = Math.max(...congs) || 1;
                                            const getX = t => 45 + ((t - minT) / (maxT - minT || 1)) * 285; const getY = c => 180 - (c / localMaxC) * 140;
                                            const ticks = []; const step = localMaxC >= 20000 ? 4000 : localMaxC >= 10000 ? 2000 : localMaxC >= 5000 ? 1000 : 500;
                                            for(let v=0; v<=localMaxC; v+=step) ticks.push(v);
                                            if (ticks[ticks.length-1] < localMaxC * 0.9) ticks.push(localMaxC);
                                            return (<><line x1="45" y1="40" x2="45" y2="180" stroke="#bdc3c7" /><line x1="45" y1="180" x2="330" y2="180" stroke="#bdc3c7" />
                                                {ticks.map(v => (<text key={v} x="40" y={getY(v) + 4} fontSize="8" fill="#7f8c8d" textAnchor="end">{formatNum(v)}</text>))}
                                                {weather.map((w, h) => {
                                                    const sel = h === currentTime;
                                                    return (<g key={h}><circle cx={getX(w.temp)} cy={getY(congs[h])} r={sel ? 5 : 3} fill={sel ? "#e74c3c" : "#3498db"} opacity={sel ? 1 : 0.6} onMouseEnter={() => setScatterTooltip({ x: getX(w.temp), y: getY(congs[h]), h, temp: w.temp, cong: congs[h] })} onMouseLeave={() => setScatterTooltip(null)} />{sel && <text x={getX(w.temp)} y={getY(congs[h]) - 8} fontSize="10" fill="#e74c3c" fontWeight="bold" textAnchor="middle">{h}h</text>}</g>);
                                                })}
                                                {scatterTooltip && (() => {
                                                    let tX = scatterTooltip.x - 55; if (tX < 5) tX = 5; if (tX + 110 > 345) tX = 345 - 110;
                                                    let tY = scatterTooltip.y - 65; if (tY < 5) tY = scatterTooltip.y + 15;
                                                    return (<g><rect x={tX} y={tY} width="110" height="55" fill="rgba(26,37,47,0.95)" rx="6" /><text x={tX + 10} y={tY + 17} fill="#bdc3c7" fontSize="8">Time:</text><text x={tX + 100} y={tY + 17} fill="#fff" fontSize="9" fontWeight="bold" textAnchor="end">{scatterTooltip.h}:00</text><text x={tX + 10} y={tY + 32} fill="#bdc3c7" fontSize="8">Temp:</text><text x={tX + 100} y={tY + 32} fill="#fff" fontSize="9" fontWeight="bold" textAnchor="end">{scatterTooltip.temp.toFixed(1)}°C</text><text x={tX + 10} y={tY + 47} fill="#bdc3c7" fontSize="8">Congest:</text><text x={tX + 100} y={tY + 47} fill="#fff" fontSize="9" fontWeight="bold" textAnchor="end">{formatNum(scatterTooltip.cong)}</text></g>);
                                                })()}
                                                <text x={getX(minT)} y={195} fontSize="9" fill="#7f8c8d" textAnchor="middle">{minT.toFixed(1)}°C</text><text x={getX(maxT)} y={195} fontSize="9" fill="#7f8c8d" textAnchor="middle">{maxT.toFixed(1)}°C</text></>);
                                        })()}
                                    </svg>
                                </div>
                                {Object.keys(selectedStation.train_data || {}).map(ln => (
                                    <div key={ln} className="chart-container">
                                        <h4>Hourly Train Saturation (%) - {ln}</h4>
                                        <div style={{display:'flex', gap:'15px', fontSize:'15px', marginBottom:'10px'}}><span style={{color:'#8e44ad'}}>● Upper/Inner</span> <span style={{color:'#e67e22'}}>● Lower/Outer</span></div>
                                        <svg viewBox="0 0 350 225" className="chart-svg">
                                            <text x="180" y="215" fontSize="10" fill="#95a5a6" textAnchor="middle">Time (Hour)</text>
                                            <text x="10" y="105" fontSize="10" fill="#95a5a6" textAnchor="middle" transform="rotate(-90 10,105)">Saturation (%)</text>
                                            {(() => {
                                                const up = selectedStation.train_data[ln].upper; const lo = selectedStation.train_data[ln].lower;
                                                const getX = i => 45 + i * (285 / 23); const getY = v => 170 - (v / 200) * 130;
                                                const ticks = [0, 50, 100, 150, 200];
                                                const yUp = getY(up[currentTime]); const yLo = getY(lo[currentTime]);
                                                const overlap = Math.abs(yUp - yLo) < 25;
                                                const offUp = overlap ? (yUp < yLo ? -10 : 18) : -7;
                                                const offLo = overlap ? (yLo < yUp ? -10 : 18) : 14;
                                                return (<><line x1="45" y1="40" x2="45" y2="170" stroke="#bdc3c7" /><line x1="45" y1="170" x2="330" y2="170" stroke="#bdc3c7" /><line x1="45" y1={getY(100)} x2="330" y2={getY(100)} stroke="#fab1a0" strokeDasharray="2" />
                                                    {ticks.map(v => (<text key={v} x="40" y={getY(v) + 4} fontSize="8" fill="#7f8c8d" textAnchor="end">{v}%</text>))}
                                                    {[0, 6, 12, 18, 23].map(h => (<text key={h} x={getX(h)} y="185" fontSize="10" fill="#7f8c8d" textAnchor="middle">{h}h</text>))}
                                                    <polyline points={up.map((v, i) => `${getX(i)},${getY(v)}`).join(' ')} fill="none" stroke="#8e44ad" strokeWidth="2" /><polyline points={lo.map((v, i) => `${getX(i)},${getY(v)}`).join(' ')} fill="none" stroke="#e67e22" strokeWidth="2" /><circle cx={getX(currentTime)} cy={yUp} r="2.5" fill="#8e44ad" /><circle cx={getX(currentTime)} cy={yLo} r="2.5" fill="#e67e22" /><text x={getX(currentTime)} y={yUp + offUp} fill="#8e44ad" fontSize="9" fontWeight="bold" textAnchor="middle">{up[currentTime]}%</text><text x={getX(currentTime)} y={yLo + offLo} fill="#e67e22" fontSize="9" fontWeight="bold" textAnchor="middle">{lo[currentTime]}%</text></>);
                                            })()}
                                        </svg>
                                    </div>
                                ))}
                                <div className="chart-container orbit-container">
                                    <h4>Similar Station Orbit</h4>
                                    <SimilarStationOrbit station={selectedStation} onCompare={setCompareStationName} />
                                </div>
                                <ComparePanel
                                    station={selectedStation}
                                    compareStation={compareStation}
                                    compareName={compareStationName}
                                    onCompareChange={setCompareStationName}
                                />
                            </div>
                        ) : (
                            <OverviewPanel overview={overview} currentTime={currentTime} weatherEvents={hourlyWeatherEvents} onHourChange={setCurrentTime} />
                        )}
                    </div>
                </div>
            </main>
        </div>
    );
}

export default App;

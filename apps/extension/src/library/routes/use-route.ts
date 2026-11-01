import { useEffect, useState } from 'react';
import { DEFAULT_ROUTE } from './pages';
import { type RouteId, routeFromHash, routeHref } from './routes';

/** The page the address names; an address with no page (or an unknown one) is rewritten to the default page. */
export function useRoute(): RouteId {
  const [route, setRoute] = useState<RouteId>(() => routeFromHash(location.hash) ?? DEFAULT_ROUTE);
  useEffect(() => {
    const sync = () => {
      const id = routeFromHash(location.hash);
      if (id === null) history.replaceState(history.state, '', routeHref(DEFAULT_ROUTE));
      setRoute(id ?? DEFAULT_ROUTE);
    };
    sync();
    addEventListener('hashchange', sync);
    return () => removeEventListener('hashchange', sync);
  }, []);
  return route;
}

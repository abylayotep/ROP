import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import * as api from '@/api';
import type { Settings } from '@/api';
import { useApi } from '@/hooks/useApi';
import { totalsOf, visibleCreatives, type AdsMeta, type Totals } from '@/lib/selectors';
import { useAppState } from '@/store/app-state';
import type { AdAccount, Creative, Profile, Seller, SellersSummary } from '@/types';

/**
 * Опорные данные кабинета: профиль проекта, рекламные аккаунты, объявления с их
 * показателями, продавцы и настройки. Грузятся один раз на приложение — счётчики
 * в меню, обзор и таблица креативов считаются из одного набора. Перезапрашиваются
 * при смене периода в шапке.
 */

interface Core {
  profile: Profile;
  accounts: AdAccount[];
  creatives: Creative[];
  adsMeta: AdsMeta;
  sellers: Seller[];
  sellersSummary: SellersSummary;
  settings: Settings;
}

interface DataContextValue {
  core: Core | undefined;
  loading: boolean;
  error: unknown;
  reload: () => void;

  /** Валюта отчётов. До загрузки профиля пусто — подставлять символ наугад нельзя. */
  currency: string;

  /** Объявления выбранных аккаунтов. Пустой массив, пока данные не пришли. */
  visible: Creative[];
  /** Итоги по видимым объявлениям и по всем — второе нужно для счётчиков меню. */
  totals: Totals | undefined;
  allTotals: Totals | undefined;

  /** Сохранение настроек с оптимистичным обновлением: экран отзывается сразу. */
  saveSettings: (patch: Partial<Settings>) => Promise<void>;
}

const DataContext = createContext<DataContextValue | null>(null);

export function DataProvider({ children }: { children: ReactNode }) {
  const { state } = useAppState();
  const period = state.period;
  const [overrides, setOverrides] = useState<Partial<Settings> | null>(null);

  const query = useApi<Core>(
    async (signal) => {
      const [profile, accounts, creatives, adsMeta, sellers, settings] = await Promise.all([
        api.getProfile(signal),
        api.listAccounts(signal),
        api.listCreatives(period, signal),
        api.listAdInsights(period, signal),
        api.listSellers(period, signal),
        api.getSettings(signal),
      ]);
      return {
        profile,
        accounts,
        creatives,
        adsMeta,
        sellers: sellers.sellers,
        sellersSummary: sellers.summary,
        settings,
      };
    },
    [period]
  );

  // Локальные правки настроек лежат поверх загруженных, чтобы интерфейс не ждал
  // ответа сервера на каждый щелчок галочки.
  const core = useMemo<Core | undefined>(() => {
    if (!query.data) return undefined;
    return overrides
      ? { ...query.data, settings: { ...query.data.settings, ...overrides } }
      : query.data;
  }, [query.data, overrides]);

  const saveSettings = useCallback(async (patch: Partial<Settings>) => {
    setOverrides((prev) => ({ ...prev, ...patch }));
    try {
      await api.updateSettings(patch);
    } catch (e) {
      // Откатываем ровно те поля, что пытались изменить.
      setOverrides((prev) => {
        if (!prev) return prev;
        const next = { ...prev };
        for (const k of Object.keys(patch)) delete next[k as keyof Settings];
        return Object.keys(next).length ? next : null;
      });
      throw e;
    }
  }, []);

  const visible = useMemo(
    () =>
      core ? visibleCreatives(core.creatives, core.accounts, core.settings.selectedAccounts) : [],
    [core]
  );

  const totals = useMemo(
    () => (core ? totalsOf(visible, core.adsMeta) : undefined),
    [core, visible]
  );
  const allTotals = useMemo(
    () => (core ? totalsOf(core.creatives, core.adsMeta) : undefined),
    [core]
  );

  const value = useMemo<DataContextValue>(
    () => ({
      core,
      loading: query.loading,
      error: query.error,
      reload: query.reload,
      currency: core?.profile.currency ?? '',
      visible,
      totals,
      allTotals,
      saveSettings,
    }),
    [core, query.loading, query.error, query.reload, visible, totals, allTotals, saveSettings]
  );

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData(): DataContextValue {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useData вызван вне DataProvider');
  return ctx;
}

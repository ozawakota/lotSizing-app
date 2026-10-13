//+------------------------------------------------------------------+
//| Mt5SyncExporter.mq5                                              |
//| 口座状態・建玉・約定履歴を CSV で書き出す EA（MT5→Turso 同期の出力側）。|
//| 出力先: <データフォルダ>/MQL5/Files/mt5sync/                        |
//|   account.csv / positions.csv / deals.csv / manifest.csv          |
//| 各ファイルは tmp に書いてから FileMove でアトミックに差し替える       |
//| （Python 側が部分書き込みを読まないように）。manifest.csv は最後に書く。|
//|                                                                    |
//| 導入: MetaEditor でコンパイルし、任意のチャートに適用するだけ。       |
//| 入力 InpIntervalSec（出力間隔秒）/ InpDealsDays（約定履歴の遡及日数）。|
//| ※ 読み取り専用。発注は一切行わない。                                |
//+------------------------------------------------------------------+
#property copyright "lotSizing-app"
#property version   "1.00"
#property strict

input int InpIntervalSec = 60;   // 出力間隔（秒）
input int InpDealsDays   = 30;   // 約定履歴を遡る日数

const string DIR = "mt5sync";

//+------------------------------------------------------------------+
int OnInit()
{
   EventSetTimer(InpIntervalSec > 0 ? InpIntervalSec : 60);
   ExportAll(); // 起動直後に1回出力
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason) { EventKillTimer(); }
void OnTimer() { ExportAll(); }

//+------------------------------------------------------------------+
//| 数値整形ヘルパ                                                    |
//+------------------------------------------------------------------+
string Money(double v) { return DoubleToString(v, 2); }
string Price(double v) { return DoubleToString(v, 5); }
string Vol(double v)   { return DoubleToString(v, 2); }

// CSV セル用に区切り/改行/引用符を除去する。
string Clean(string s)
{
   StringReplace(s, ",", " ");
   StringReplace(s, "\r", " ");
   StringReplace(s, "\n", " ");
   StringReplace(s, "\"", " ");
   return s;
}

// epoch ミリ秒（UTC）。
long NowMs() { return (long)TimeGMT() * 1000; }

//+------------------------------------------------------------------+
//| content を DIR\<name> にアトミックに書き出す（tmp→FileMove）。      |
//+------------------------------------------------------------------+
bool WriteAtomic(string name, string content)
{
   string tmp = DIR + "\\" + name + ".tmp";
   string dst = DIR + "\\" + name;
   int h = FileOpen(tmp, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE)
   {
      PrintFormat("mt5sync: FileOpen 失敗 %s err=%d", tmp, GetLastError());
      return false;
   }
   FileWriteString(h, content);
   FileClose(h);
   // 既存を上書きで差し替え。
   if(!FileMove(tmp, 0, dst, FILE_REWRITE))
   {
      PrintFormat("mt5sync: FileMove 失敗 %s→%s err=%d", tmp, dst, GetLastError());
      return false;
   }
   return true;
}

//+------------------------------------------------------------------+
//| 口座 CSV                                                          |
//+------------------------------------------------------------------+
string BuildAccount()
{
   string head = "login,broker,currency,leverage,balance,equity,margin,margin_free,margin_level,profit\n";
   string row = StringFormat("%I64d,%s,%s,%I64d,%s,%s,%s,%s,%s,%s\n",
      (long)AccountInfoInteger(ACCOUNT_LOGIN),
      Clean(AccountInfoString(ACCOUNT_COMPANY)),
      Clean(AccountInfoString(ACCOUNT_CURRENCY)),
      (long)AccountInfoInteger(ACCOUNT_LEVERAGE),
      Money(AccountInfoDouble(ACCOUNT_BALANCE)),
      Money(AccountInfoDouble(ACCOUNT_EQUITY)),
      Money(AccountInfoDouble(ACCOUNT_MARGIN)),
      Money(AccountInfoDouble(ACCOUNT_MARGIN_FREE)),
      Money(AccountInfoDouble(ACCOUNT_MARGIN_LEVEL)),
      Money(AccountInfoDouble(ACCOUNT_PROFIT)));
   return head + row;
}

//+------------------------------------------------------------------+
//| 建玉 CSV                                                          |
//+------------------------------------------------------------------+
string BuildPositions(long login)
{
   string s = "ticket,login,symbol,type,volume,price_open,sl,tp,price_current,profit,swap,time_open\n";
   int total = PositionsTotal();
   for(int i = 0; i < total; i++)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0 || !PositionSelectByTicket(ticket)) continue;
      string type = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY) ? "buy" : "sell";
      s += StringFormat("%I64u,%I64d,%s,%s,%s,%s,%s,%s,%s,%s,%s,%I64d\n",
         ticket, login,
         Clean(PositionGetString(POSITION_SYMBOL)), type,
         Vol(PositionGetDouble(POSITION_VOLUME)),
         Price(PositionGetDouble(POSITION_PRICE_OPEN)),
         Price(PositionGetDouble(POSITION_SL)),
         Price(PositionGetDouble(POSITION_TP)),
         Price(PositionGetDouble(POSITION_PRICE_CURRENT)),
         Money(PositionGetDouble(POSITION_PROFIT)),
         Money(PositionGetDouble(POSITION_SWAP)),
         (long)PositionGetInteger(POSITION_TIME) * 1000);
   }
   return s;
}

//+------------------------------------------------------------------+
//| 約定履歴 CSV（直近 InpDealsDays 日）                               |
//+------------------------------------------------------------------+
string DealTypeStr(long t)
{
   if(t == DEAL_TYPE_BUY)     return "buy";
   if(t == DEAL_TYPE_SELL)    return "sell";
   if(t == DEAL_TYPE_BALANCE) return "balance";
   if(t == DEAL_TYPE_CREDIT)  return "credit";
   return "other";
}
string DealEntryStr(long e)
{
   if(e == DEAL_ENTRY_IN)     return "in";
   if(e == DEAL_ENTRY_OUT)    return "out";
   if(e == DEAL_ENTRY_INOUT)  return "inout";
   if(e == DEAL_ENTRY_OUT_BY) return "out_by";
   return "other";
}

string BuildDeals(long login)
{
   string s = "deal_id,login,order_id,position_id,symbol,type,entry,volume,price,profit,commission,swap,time,comment\n";
   datetime from = TimeGMT() - (datetime)InpDealsDays * 24 * 60 * 60;
   if(!HistorySelect(from, TimeGMT())) return s;
   int total = HistoryDealsTotal();
   for(int i = 0; i < total; i++)
   {
      ulong ticket = HistoryDealGetTicket(i);
      if(ticket == 0) continue;
      s += StringFormat("%I64u,%I64d,%I64d,%I64d,%s,%s,%s,%s,%s,%s,%s,%s,%I64d,%s\n",
         ticket, login,
         (long)HistoryDealGetInteger(ticket, DEAL_ORDER),
         (long)HistoryDealGetInteger(ticket, DEAL_POSITION_ID),
         Clean(HistoryDealGetString(ticket, DEAL_SYMBOL)),
         DealTypeStr((long)HistoryDealGetInteger(ticket, DEAL_TYPE)),
         DealEntryStr((long)HistoryDealGetInteger(ticket, DEAL_ENTRY)),
         Vol(HistoryDealGetDouble(ticket, DEAL_VOLUME)),
         Price(HistoryDealGetDouble(ticket, DEAL_PRICE)),
         Money(HistoryDealGetDouble(ticket, DEAL_PROFIT)),
         Money(HistoryDealGetDouble(ticket, DEAL_COMMISSION)),
         Money(HistoryDealGetDouble(ticket, DEAL_SWAP)),
         (long)HistoryDealGetInteger(ticket, DEAL_TIME) * 1000,
         Clean(HistoryDealGetString(ticket, DEAL_COMMENT)));
   }
   return s;
}

//+------------------------------------------------------------------+
//| 全出力（manifest を最後に書く＝1セット完了の合図）。                |
//+------------------------------------------------------------------+
void ExportAll()
{
   long login = (long)AccountInfoInteger(ACCOUNT_LOGIN);
   long gen = NowMs();

   bool ok = true;
   ok = WriteAtomic("account.csv",   BuildAccount())        && ok;
   ok = WriteAtomic("positions.csv", BuildPositions(login)) && ok;
   ok = WriteAtomic("deals.csv",     BuildDeals(login))     && ok;
   if(!ok)
   {
      Print("mt5sync: 出力に失敗したため manifest は書きません（次回リトライ）");
      return;
   }
   string manifest = StringFormat("generated_at,login\n%I64d,%I64d\n", gen, login);
   WriteAtomic("manifest.csv", manifest);
}
//+------------------------------------------------------------------+

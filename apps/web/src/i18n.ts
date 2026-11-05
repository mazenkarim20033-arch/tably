import { useSyncExternalStore } from 'react';

/**
 * Two languages for the friends' page. English text is the key, so a missing translation just shows English.
 * The language follows the phone's language the first time, then whatever the person picks.
 */
export type Lang = 'en' | 'ar';

const KEY = 'tably.lang';

function initial(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'ar' || saved === 'en') return saved;
  } catch { /* private mode */ }
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('ar') ? 'ar' : 'en';
}

let lang: Lang = initial();
const listeners = new Set<() => void>();

function apply() {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
}
apply();

export function setLang(next: Lang) {
  lang = next;
  try { localStorage.setItem(KEY, next); } catch { /* private mode */ }
  apply();
  listeners.forEach((l) => l());
}

/** Re-renders the component when the language changes. */
export function useLang(): Lang {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => lang);
}

export const currentLang = () => lang;

const AR: Record<string, string> = {
  'Split the bill, not the friendship.': 'قسّم الفاتورة، لا الصداقة.',
  'Open the link a friend sent you to pick what you had and pay your share.': 'افتح الرابط الذي أرسله لك صديقك لتختار ما طلبته وتدفع حصتك.',
  'Someone just took that. Pick something else.': 'شخص آخر اختار هذا الصنف للتو. اختر شيئاً آخر.',
  'Could not reach the server. Check your connection.': 'تعذر الاتصال بالخادم. تحقق من اتصالك بالإنترنت.',
  'This link has expired': 'انتهت صلاحية هذا الرابط',
  'This link is turned off': 'تم إيقاف هذا الرابط',
  'Bill not found': 'لم يتم العثور على الفاتورة',
  'Check the link, or ask for a new one.': 'تحقق من الرابط أو اطلب رابطاً جديداً.',
  'Loading the bill…': 'جارٍ تحميل الفاتورة…',
  'Split the bill': 'قسّم الفاتورة',
  '{n} item': '{n} صنف',
  '{n} items': '{n} أصناف',
  '{names} and {n} more joined': 'انضم {names} و{n} آخرون',
  '{names} joined': 'انضم {names}',
  'This bill is closed.': 'هذه الفاتورة مغلقة.',
  'Hi {name}': 'أهلاً {name}',
  'Tap what you had.': 'اضغط على ما طلبته.',
  'Had a bit of everything? Split it all evenly': 'أكلت من كل شيء؟ قسّم الكل بالتساوي',
  'Paid · confirmed': 'تم الدفع · مؤكد',
  '{name} confirmed it. Ask them if something needs to change.': 'أكّد {name} الدفع. اسأله إذا احتجت لتعديل شيء.',
  'The bill creator': 'صاحب الفاتورة',
  "You've said you paid": 'ذكرت أنك دفعت',
  'Your payment has started': 'بدأت عملية الدفع',
  'Your items are locked while it stands. Forgot something? Undo it, change your items, then pay again.': 'أصنافك مقفلة طالما الدفع قائم. نسيت شيئاً؟ تراجع، عدّل أصنافك، ثم ادفع من جديد.',
  'Undo and edit my items': 'تراجع وعدّل أصنافي',
  'Items': 'الأصناف',
  'Receipt items': 'أصناف الفاتورة',
  'Totals': 'الإجماليات',
  'Discounts': 'الخصومات',
  'Service': 'الخدمة',
  'Tax': 'الضريبة',
  'Tip': 'البقشيش',
  'Bill total': 'إجمالي الفاتورة',
  'You owe': 'عليك',
  '{amount} items': '{amount} أصناف',
  ' + {amount} share of extras': ' + {amount} حصتك من الإضافات',
  ' + {amount} you are covering': ' + {amount} تدفعها عن غيرك',
  ' − {amount} covered for you': ' − {amount} دُفعت عنك',
  'Pay': 'ادفع',
  'The bill creator has not added payment details yet': 'صاحب الفاتورة لم يضف بيانات الدفع بعد',
  'Who are you?': 'من أنت؟',
  'Add your name, then tap the items you had. Everyone sees who picked what.': 'اكتب اسمك ثم اضغط على ما طلبته. الجميع يرى من اختار ماذا.',
  'Your name': 'اسمك',
  'Join and pick items': 'انضم واختر الأصناف',
  'Joining…': 'جارٍ الانضمام…',
  'Could not join.': 'تعذر الانضمام.',
  'Split': 'تقسيم',
  '(split)': '(مشترك)',
  'Fewer': 'أقل',
  'More': 'أكثر',
  'Who has what': 'من أخذ ماذا',
  'Everything is claimed.': 'تم اختيار كل شيء.',
  '{amount} still unclaimed': 'متبقي {amount} بدون اختيار',
  '{amount} confirmed paid of {total}': 'تم تأكيد دفع {amount} من {total}',
  'Not paid': 'لم يُدفع',
  'covers {amount} for others': 'يدفع {amount} عن الآخرين',
  '{amount} covered': 'دُفع عنه {amount}',
  'Payment started': 'بدأ الدفع',
  'Waiting for confirmation': 'بانتظار التأكيد',
  'Not confirmed': 'لم يتم التأكيد',
  'Expired': 'انتهت المهلة',
  'Cancelled': 'أُلغي',
  'Opens InstaPay for you': 'يفتح إنستاباي لك',
  'Send from any bank app': 'أرسل من أي تطبيق بنكي',
  'Pay in person': 'ادفع شخصياً',
  'Mobile wallet': 'محفظة موبايل',
  'Other': 'أخرى',
  'Cash': 'نقداً',
  'Copy': 'نسخ',
  'Copied': 'تم النسخ',
  'Amount to send': 'المبلغ المطلوب إرساله',
  'Copy amount': 'نسخ المبلغ',
  'Open InstaPay to pay {name}': 'افتح إنستاباي للدفع إلى {name}',
  'or send to': 'أو أرسل إلى',
  'InstaPay address': 'عنوان إنستاباي',
  'Phone number': 'رقم الهاتف',
  'Telda tag or number': 'معرّف تيلدا أو الرقم',
  'Open Telda, search for {name}, and send exactly this amount.': 'افتح تيلدا وابحث عن {name} وأرسل هذا المبلغ بالضبط.',
  '{name} number': 'رقم {name}',
  'Open your wallet app and send exactly this amount to this number.': 'افتح محفظتك وأرسل هذا المبلغ بالضبط إلى هذا الرقم.',
  'Hand {amount} to {name}': 'سلّم {amount} إلى {name}',
  'They mark it paid once they have it.': 'سيؤكد الدفع بمجرد استلامه.',
  '{name} confirmed they received {amount}. You are all set.': 'أكّد {name} أنه استلم {amount}. كل شيء تمام.',
  'You said you sent {amount}. It counts as paid once {name} sees it in their account and confirms.': 'ذكرت أنك أرسلت {amount}. يُعتبر مدفوعاً عندما يراه {name} في حسابه ويؤكده.',
  "Tapped by mistake, or forgot an item? Undo, change your items, then pay again. Only undo if you haven't sent the money.": 'ضغطت بالخطأ أو نسيت صنفاً؟ تراجع وعدّل أصنافك ثم ادفع من جديد. تراجع فقط إذا لم ترسل المال.',
  "Undo, I haven't paid": 'تراجع، لم أدفع',
  'Pay {amount}': 'ادفع {amount}',
  'Send {amount}': 'أرسل {amount}',
  '{name} could not find your last payment. Send it again or ask them.': 'لم يجد {name} دفعتك الأخيرة. أرسلها مرة أخرى أو اسأله.',
  'The last attempt timed out. You can start again.': 'انتهت مهلة المحاولة السابقة. يمكنك البدء من جديد.',
  'How do you want to pay {name}?': 'كيف تريد الدفع إلى {name}؟',
  'Cancel payment': 'إلغاء الدفع',
  'Close': 'إغلاق',
  '‹ Other ways to pay': '‹ طرق دفع أخرى',
  'Welcome back.': 'مرحباً بعودتك.',
  'Did you send {amount}?': 'هل أرسلت {amount}؟',
  "Yes, I've paid": 'نعم، دفعت',
  'Not yet': 'ليس بعد',
  'How to pay': 'طريقة الدفع',
  'Open your banking app or wallet and send exactly the amount to {name}.': 'افتح تطبيق البنك أو المحفظة وأرسل المبلغ بالضبط إلى {name}.',
  'Come back here and tap "I\'ve paid". It is only marked paid once {name} confirms they received it.': 'ارجع هنا واضغط "دفعت". لا يُعتبر مدفوعاً إلا بعد أن يؤكد {name} استلامه.',
  "Your bank's reference number (optional)": 'رقم مرجع البنك (اختياري)',
  "I've paid in cash": 'دفعت نقداً',
  "I've paid": 'دفعت',
  'Something went wrong. Please try again.': 'حدث خطأ. حاول مرة أخرى.',
};

/** Translate an English phrase (with {placeholders}) into the current language. */
export function t(text: string, vars?: Record<string, string | number>): string {
  const base = lang === 'ar' ? AR[text] ?? text : text;
  return vars ? base.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? '')) : base;
}

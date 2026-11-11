import {publicPortraitCatalogue} from '@/lib/public-catalogue';
import Studio from '@/components/studio';
import {getChatGPTUser,chatGPTSignInPath,chatGPTSignOutPath} from '../../chatgpt-auth';
export const dynamic='force-dynamic';
export default async function StudioArchivePage(){
 const user=await getChatGPTUser();
 return <Studio catalogue={publicPortraitCatalogue()} signedIn={!!user} displayName={user?.displayName??null} signInHref={chatGPTSignInPath('/studio/archive')} signOutHref={chatGPTSignOutPath('/studio/archive')}/>;
}

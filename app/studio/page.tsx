import {publicPortraitCatalogue} from '@/lib/public-catalogue';
import PortraitExperience from '@/components/portrait-experience';
import {getChatGPTUser,chatGPTSignInPath,chatGPTSignOutPath} from '../chatgpt-auth';
export const dynamic='force-dynamic';
export default async function StudioPage(){
 const user=await getChatGPTUser();
 return <PortraitExperience catalogue={publicPortraitCatalogue()} signedIn={!!user} displayName={user?.displayName??null} accountId={user?.userId??null} signInHref={chatGPTSignInPath('/studio')} signOutHref={chatGPTSignOutPath('/studio')}/>;
}
